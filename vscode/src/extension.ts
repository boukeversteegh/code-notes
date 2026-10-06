import { type FSWatcher, existsSync, mkdirSync, watch } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { type Located, buildAnchor } from "../../src/anchor.ts";
import { describeLines, describeMatch, originalCode, withoutEmail } from "../../src/format.ts";
import { type NoteDoc, keyFor, newManualId } from "../../src/gitnotes.ts";
import { githubDeletionReply, setGithubToken, setThreadResolved } from "../../src/github.ts";
import type { FileNote } from "../../src/notes.ts";
import { toRepoPath } from "../../src/repo.ts";
import { ThreadStates } from "../../src/thread-states.ts";
import type { RepoInfo } from "./worker.ts";

interface ThreadInfo {
  root: string;
  key: string;
  doc: NoteDoc;
}

type SyncResult = { fetched: boolean; merged: number; pushed: boolean };

/** A comment in a note thread; comments written locally can be edited in place. */
class NoteComment implements vscode.Comment {
  savedBody: string;
  mode = vscode.CommentMode.Preview;
  contextValue: string;
  thread?: vscode.CommentThread;

  constructor(
    public body: string | vscode.MarkdownString,
    public author: vscode.CommentAuthorInformation,
    public timestamp: Date,
    readonly root: string,
    readonly key: string,
    readonly index: number,
    editable: boolean,
    public label?: string,
    /** createdAt of the stored comment, to identify it when removing. */
    readonly createdAt?: string,
  ) {
    this.savedBody = typeof body === "string" ? body : body.value;
    // Used by the menus: "first-…" gets the delete button, "…-editable" the edit buttons.
    this.contextValue = `${index === 0 ? "first" : "reply"}-${editable ? "editable" : "readonly"}`;
  }
}

/** What the status bar says while an operation runs; operations not listed here are too quick to mention. */
const ACTIVITY: Record<string, string> = {
  notesForFile: "loading notes",
  count: "loading notes",
  sync: "syncing",
  createNote: "saving",
  addComment: "saving",
  editComment: "saving",
  removeComment: "saving",
  softDelete: "saving",
  importGithub: "importing from GitHub",
};

/** Requests to the git worker (see worker.ts); every git call happens there, off the extension host thread. */
class GitWorker {
  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<number, { op: string; resolve: (v: any) => void; reject: (e: Error) => void; log?: (m: string) => void }>();
  /** Called when the set of running operations changes, with the activities still running. */
  onBusyChange: (activities: string[]) => void = () => {};

  constructor(file: string) {
    this.worker = new Worker(file);
    this.worker.on("message", ({ id, result, error, log }: { id: number; result?: unknown; error?: string; log?: string }) => {
      const p = this.pending.get(id);
      if (!p) return;
      if (log !== undefined) return p.log?.(log);
      this.pending.delete(id);
      if (ACTIVITY[p.op]) this.onBusyChange(this.activities());
      if (error !== undefined) p.reject(new Error(error));
      else p.resolve(result);
    });
  }

  activities(): string[] {
    return [...new Set([...this.pending.values()].flatMap((p) => (ACTIVITY[p.op] ? [ACTIVITY[p.op]] : [])))];
  }

  call<T>(op: string, args: Record<string, unknown>, log?: (msg: string) => void): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { op, resolve, reject, log });
      if (ACTIVITY[op]) this.onBusyChange(this.activities());
      this.worker.postMessage({ id, op, args });
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Code Notes");
  const controller = vscode.comments.createCommentController("code-notes", "Code notes");
  const git = new GitWorker(join(__dirname, "worker.js"));
  /** Rendered threads per document, by note key, with a signature of what they show, so re-renders update in place. */
  const threadsByDoc = new Map<string, Map<string, { thread: vscode.CommentThread; signature: string }>>();
  /** Latest render per document; an older render that finishes later is discarded. */
  const renderGeneration = new Map<string, number>();
  /** Notes you replied to, edited or created in this session; they stay open through re-renders. */
  const keepOpen = new Set<string>();
  const threadsOf = (doc: vscode.TextDocument) => [...(threadsByDoc.get(doc.uri.toString())?.values() ?? [])].map((r) => r.thread);
  const threadInfo = new WeakMap<vscode.CommentThread, ThreadInfo>();
  const repoByDir = new Map<string, Promise<RepoInfo | null>>();
  const knownRepos: RepoInfo[] = [];
  const authors = new Map<string, string>();
  const refWatchers = new Map<string, FSWatcher[]>();
  /** Threads whose GitHub state is being looked up, so a render does not start a second lookup. */
  const lookingUp = new Set<string>();

  const log = (msg: string) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);

  /**
   * Status bar: what the extension is doing (with a spinner), or when it last synced. Short operations do not
   * show the spinner, so it does not flicker. Clicking it refreshes (syncs) the notes.
   */
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = "codeNotes.refresh";
  let lastSync: Date | null = null;
  let statusTimer: NodeJS.Timeout | undefined;
  const showIdle = () => {
    status.text = "$(comment-discussion) Code Notes";
    status.tooltip = `Code Notes${lastSync ? ` · last synced ${lastSync.toLocaleTimeString()}` : ""}\nClick to sync notes with the remote.`;
  };
  git.onBusyChange = (activities) => {
    clearTimeout(statusTimer);
    if (activities.length === 0) return showIdle();
    statusTimer = setTimeout(() => {
      status.text = `$(sync~spin) Code Notes: ${activities.join(", ")}…`;
      status.tooltip = "Code Notes is working in the background.";
    }, 300);
  };
  showIdle();
  status.show();

  /** Runs a command handler, reporting failures instead of failing silently. */
  const guarded = <A extends unknown[]>(name: string, fn: (...args: A) => unknown) => async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      log(`${name} failed: ${String((err as Error).stack ?? err)}`);
      vscode.window.showErrorMessage(`Code Notes: ${name} failed: ${(err as Error).message}`);
    }
  };
  const background = (name: string, work: Promise<unknown>) => work.catch((err) => log(`${name} failed: ${(err as Error).message}`));

  // ---- Repositories ----

  const knownRepoFor = (filePath: string) => knownRepos.find((r) => isWithin(r.root, dirname(filePath)));

  /** The repository of a file; the first lookup per repository happens in the worker. */
  const repoFor = async (filePath: string): Promise<RepoInfo | null> => {
    const known = knownRepoFor(filePath);
    if (known) return known;
    const dir = dirname(filePath);
    if (!repoByDir.has(dir)) {
      repoByDir.set(dir, git.call<RepoInfo | null>("repoInfo", { dir }).then((info) => {
        if (!info) return null;
        const existing = knownRepos.find((r) => r.root === info.root);
        if (existing) return existing;
        knownRepos.push(info);
        watchNotesRef(info);
        background("looking up the git identity", git.call<string>("author", { root: info.root }).then((a) => authors.set(info.root, a)));
        // Pull right away, so a fresh clone shows the shared notes without waiting for the next periodic pull.
        background(`pull ${info.root}`, syncRepo(info.root));
        return info;
      }));
    }
    return repoByDir.get(dir)!;
  };

  /** Re-renders when the shared notes ref points to a new commit (a write here, in another worktree, by the CLI or a sync). */
  const watchNotesRef = (info: RepoInfo) => {
    if (refWatchers.has(info.commonDir)) return;
    const notesDir = join(info.commonDir, "refs", "notes");
    mkdirSync(notesDir, { recursive: true });
    let timer: NodeJS.Timeout | undefined;
    let lastHead: string | null | undefined;
    background("reading the notes ref", git.call<string | null>("head", { root: info.root }).then((h) => (lastHead ??= h)));
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => background("reading the notes ref", git.call<string | null>("head", { root: info.root }).then((head) => {
        // Lock files and rewrites of the same value also trigger the watcher; only a new notes commit matters.
        if (head === lastHead) return;
        lastHead = head;
        renderAll();
      })), 300);
    };
    const watchers = [watch(notesDir, changed)];
    if (existsSync(join(info.commonDir, "packed-refs"))) watchers.push(watch(join(info.commonDir, "packed-refs"), changed));
    refWatchers.set(info.commonDir, watchers);
  };

  // ---- Rendering: only files visible in an editor show notes (and appear in the Comments panel) ----

  /** Marks the lines a note covers: a bar in the gutter and a mark in the overview ruler. */
  const rangeDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: gutterBar("#3794ff"),
    gutterIconSize: "cover",
    overviewRulerColor: "rgba(55, 148, 255, 0.6)",
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  const showRanges = (editor: vscode.TextEditor) => {
    const ranges = threadsOf(editor.document).flatMap((t) => (t.range ? [t.range] : []));
    editor.setDecorations(rangeDecoration, ranges);
  };

  const showRangesFor = (doc: vscode.TextDocument) =>
    vscode.window.visibleTextEditors.filter((e) => e.document === doc).forEach(showRanges);

  const visibleDocuments = () => [...new Set(vscode.window.visibleTextEditors.map((e) => e.document))];

  const clear = (doc: vscode.TextDocument) => {
    renderGeneration.set(doc.uri.toString(), (renderGeneration.get(doc.uri.toString()) ?? 0) + 1);
    threadsOf(doc).forEach((t) => t.dispose());
    threadsByDoc.delete(doc.uri.toString());
  };

  /**
   * Shows the notes of a document. Notes are loaded and placed in the worker. Threads are matched to notes by
   * key: unchanged notes keep their thread untouched (so an open note stays open), changed notes are updated
   * in place, and only new or removed notes create or dispose threads.
   */
  const render = async (doc: vscode.TextDocument) => {
    const uri = doc.uri.toString();
    const generation = (renderGeneration.get(uri) ?? 0) + 1;
    renderGeneration.set(uri, generation);
    let found: { info: RepoInfo; notes: FileNote[]; placed: (Located | null)[] } | null = null;
    if (doc.uri.scheme === "file") {
      const info = await repoFor(doc.uri.fsPath);
      if (info) {
        const r = await git.call<{ notes: FileNote[]; placed: (Located | null)[] }>("notesForFile", {
          info, path: toRepoPath(doc.uri.fsPath, info.root, info.root), lines: doc.getText().split(/\r?\n/),
        });
        found = { info, ...r };
      }
    }
    // A newer render started, or the file is no longer visible, while this one waited for the worker.
    if (renderGeneration.get(uri) !== generation || !visibleDocuments().includes(doc)) return;
    const previous = threadsByDoc.get(uri) ?? new Map<string, { thread: vscode.CommentThread; signature: string }>();
    const next = new Map<string, { thread: vscode.CommentThread; signature: string }>();
    if (found && found.notes.length > 0) {
      const { info, notes, placed } = found;
      const expand = vscode.workspace.getConfiguration("codeNotes").get<"none" | "all">("expand", "none");
      const states = new ThreadStates(info.root);
      notes.forEach((note, i) => {
        const resolved = note.doc.github ? states.get(note.doc.github.threadId) : undefined;
        const signature = JSON.stringify([note.doc, placed[i], resolved, note.originalPath]);
        const old = previous.get(note.key);
        if (old?.signature === signature) {
          next.set(note.key, old);
          return;
        }
        const thread = old?.thread ?? createThread(controller, doc, expand);
        fillThread(thread, doc, info.root, note, placed[i], resolved);
        if (keepOpen.has(note.key)) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        threadInfo.set(thread, { root: info.root, key: note.key, doc: note.doc });
        next.set(note.key, { thread, signature });
      });
      refreshGithubStates(info.root, notes, doc.uri.fsPath);
    }
    for (const [key, r] of previous) if (!next.has(key)) r.thread.dispose();
    if (next.size) threadsByDoc.set(uri, next);
    else threadsByDoc.delete(uri);
    showRangesFor(doc);
  };

  const renderDoc = (doc: vscode.TextDocument) => background(`showing notes of ${doc.uri.fsPath}`, render(doc));

  /** Re-renders the visible documents of one file path, e.g. after a write. */
  const renderPath = (fsPath: string) => {
    visibleDocuments().filter((d) => d.uri.fsPath === fsPath).forEach(renderDoc);
    decorationsChanged.fire(vscode.Uri.file(fsPath));
  };

  const renderAll = () => {
    visibleDocuments().forEach(renderDoc);
    decorationsChanged.fire(undefined);
  };

  /** Shows notes for files that became visible and removes them from files that are no longer visible. */
  const visibleChanged = (editors: readonly vscode.TextEditor[]) => {
    const visible = new Set(editors.map((e) => e.document.uri.toString()));
    for (const [uri, rendered] of threadsByDoc) {
      if (visible.has(uri)) continue;
      renderGeneration.set(uri, (renderGeneration.get(uri) ?? 0) + 1); // cancel a render still in progress
      for (const r of rendered.values()) r.thread.dispose();
      threadsByDoc.delete(uri);
    }
    for (const doc of new Set(editors.map((e) => e.document))) {
      if (threadsByDoc.has(doc.uri.toString())) showRangesFor(doc);
      else renderDoc(doc);
    }
  };

  // VS Code only requests decorations for items rendered in the Explorer (and open tabs).
  const decorationsChanged = new vscode.EventEmitter<vscode.Uri | undefined>();
  const decorations: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: decorationsChanged.event,
    async provideFileDecoration(uri) {
      if (uri.scheme !== "file") return;
      const info = await repoFor(uri.fsPath);
      if (!info) return;
      const count = await git.call<number>("count", { info, path: toRepoPath(uri.fsPath, info.root, info.root) });
      if (!count) return;
      return new vscode.FileDecoration("💬", `${count} code note${count === 1 ? "" : "s"}`);
    },
  };

  // Every line of a file in a git repo can get a new note.
  controller.commentingRangeProvider = {
    provideCommentingRanges: async (doc) =>
      doc.uri.scheme === "file" && (await repoFor(doc.uri.fsPath)) ? [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)] : [],
  };
  controller.options = { placeHolder: "Write a code note…", prompt: "Add a code note" };

  // ---- GitHub ----

  const githubSession = async (interactive: boolean) => {
    const session = await vscode.authentication.getSession("github", ["repo"], interactive ? { createIfNone: true } : { silent: true });
    if (session) setGithubToken(session.accessToken);
    return session?.accessToken;
  };

  /**
   * Looks up on GitHub whether the conversations behind the notes on a file are resolved (cached for a few
   * minutes) and re-renders the file when an answer arrives. Needs a GitHub sign-in; without one, nothing is shown.
   */
  const refreshGithubStates = (root: string, notes: FileNote[], fsPath: string) => {
    const states = new ThreadStates(root);
    const missing = notes.flatMap((n) => (n.doc.github && states.get(n.doc.github.threadId) === undefined && !lookingUp.has(n.doc.github.threadId) ? [n.doc.github.threadId] : []));
    if (missing.length === 0) return;
    missing.forEach((id) => lookingUp.add(id));
    (async () => {
      if (!(await githubSession(false))) return;
      await states.refresh(missing);
      renderPath(fsPath);
    })()
      .catch((err) => log(`GitHub status check failed: ${(err as Error).message}`))
      .finally(() => missing.forEach((id) => lookingUp.delete(id)));
  };

  const setResolved = (resolved: boolean) => async (thread: vscode.CommentThread) => {
    const t = threadInfo.get(thread);
    if (!t?.doc.github) return;
    await githubSession(true);
    const state = await setThreadResolved(t.doc.github.threadId, resolved);
    new ThreadStates(t.root).set(t.doc.github.threadId, state);
    log(`${state ? "resolved" : "reopened"} GitHub conversation of note ${t.key}`);
    renderPath(thread.uri.fsPath);
  };

  const openOnGithub = (thread: vscode.CommentThread) => {
    const t = threadInfo.get(thread);
    const url = t?.doc.github?.url ?? t?.doc.pr?.url;
    if (url) vscode.env.openExternal(vscode.Uri.parse(url));
  };

  // ---- Sync (in the worker) ----

  /** Pushes and pulls notes in the background after a change, when enabled. */
  const syncAfterChange = (root: string) => {
    if (!vscode.workspace.getConfiguration("codeNotes").get<boolean>("syncOnChange", true)) return;
    background(`sync ${root}`, syncRepo(root));
  };

  /** Running sync per repo; a change made while one runs queues exactly one follow-up sync. */
  const syncing = new Map<string, Promise<SyncResult | null>>();
  const queued = new Set<string>();
  const syncRepo = async (root: string): Promise<SyncResult | null> => {
    const running = syncing.get(root);
    if (running) {
      if (queued.has(root)) return running;
      queued.add(root);
      await running.catch(() => {});
      queued.delete(root);
      return syncRepo(root);
    }
    const run = (async () => {
      if (!(await git.call<string | null>("defaultRemote", { root }))) return null; // no remote: notes stay local
      const r = await git.call<SyncResult>("sync", { root });
      lastSync = new Date();
      if (!git.activities().length) showIdle();
      if (r.merged || r.pushed) log(`sync ${root}: merged ${r.merged}, pushed ${r.pushed}`);
      return r;
    })();
    syncing.set(root, run);
    try {
      return await run;
    } finally {
      syncing.delete(root);
    }
  };

  /** Pulls notes for every repo seen so far: when the window gains focus and every `codeNotes.pullInterval` seconds. */
  const pullAll = () => {
    for (const info of new Map(knownRepos.map((r) => [r.commonDir, r])).values()) background(`pull ${info.root}`, syncRepo(info.root));
  };
  let pullTimer: NodeJS.Timeout | undefined;
  const schedulePull = () => {
    clearInterval(pullTimer);
    const seconds = vscode.workspace.getConfiguration("codeNotes").get<number>("pullInterval", 60);
    if (seconds > 0) pullTimer = setInterval(pullAll, seconds * 1000);
  };
  schedulePull();

  const authorOf = async (root: string) => authors.get(root) ?? (await git.call<string>("author", { root }));

  // ---- Writing: the UI updates first, the worker writes, then the file is re-rendered ----

  /** Disables replying on a thread while a write is running, so nothing is posted twice. */
  const whileSaving = async (thread: vscode.CommentThread, work: () => Promise<unknown>) => {
    thread.canReply = false;
    try {
      await work();
    } finally {
      thread.canReply = true;
    }
  };

  const createNote = async (reply: vscode.CommentReply) => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === reply.thread.uri.toString());
    if (!doc) throw new Error("the document of this note is not open");
    const info = await repoFor(reply.thread.uri.fsPath);
    if (!info) throw new Error(`${reply.thread.uri.fsPath} is not inside a git repository`);
    const path = toRepoPath(reply.thread.uri.fsPath, info.root, info.root);
    const lines = doc.getText().split(/\r?\n/);
    let anchor;
    if (reply.thread.range) {
      // A note covers the selected lines. A selection that ends at the start of a line does not include that line.
      const { start: from, end: to } = reply.thread.range;
      const start = from.line + 1;
      const end = Math.max(start, to.character === 0 && to.line > from.line ? to.line : to.line + 1);
      anchor = buildAnchor(lines, start, end, null);
    } else {
      anchor = { commit: null, startLine: null, endLine: null, text: null }; // a note on the whole file
    }
    const id = newManualId(), now = new Date().toISOString(), key = keyFor(id);
    const author = await authorOf(info.root);
    const note: NoteDoc = {
      schema: 1, id, source: "manual", path, anchor,
      summary: null, comments: [{ author, body: reply.text, createdAt: now, source: "local" }],
      pr: null, createdAt: now, updatedAt: now, deleted: null, restoredAt: null,
    };
    // Show the note right away; the worker writes it (anchored to HEAD unless the file has unsaved changes).
    reply.thread.dispose();
    const range = anchor.endLine ? { start: anchor.startLine!, end: anchor.endLine, match: "exact" as const } : null;
    const shown = createThread(controller, doc, "all");
    keepOpen.add(key);
    fillThread(shown, doc, info.root, { key, doc: note, originalPath: null }, range, undefined, "saving…");
    threadInfo.set(shown, { root: info.root, key, doc: note });
    const rendered = threadsByDoc.get(doc.uri.toString()) ?? new Map();
    rendered.set(key, { thread: shown, signature: "" });
    threadsByDoc.set(doc.uri.toString(), rendered);
    showRangesFor(doc);
    await whileSaving(shown, () => git.call("createNote", { root: info.root, key, doc: note, anchorToHead: !doc.isDirty && !!anchor.endLine }));
    log(`added note ${key} on ${path}:${describeLines(range)}`);
    renderPath(doc.uri.fsPath);
    syncAfterChange(info.root);
  };

  /** Opens an empty note box on the selected lines; the same as the gutter `+`, for when that is not available. */
  const addNoteOnSelection = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error("open a file first");
    const sel = editor.selection;
    const thread = controller.createCommentThread(editor.document.uri, new vscode.Range(sel.start.line, 0, sel.end.line, 0), []);
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  };

  const replyNote = async (reply: vscode.CommentReply) => {
    const t = threadInfo.get(reply.thread);
    if (!t) return;
    const author = await authorOf(t.root);
    const createdAt = new Date().toISOString();
    // Show the reply right away, marked as saving; replying is disabled until the worker has written it.
    const shown = new NoteComment(reply.text, { name: withoutEmail(author) }, new Date(createdAt), t.root, t.key, reply.thread.comments.length, true, "saving…", createdAt);
    shown.thread = reply.thread;
    reply.thread.comments = [...reply.thread.comments, shown];
    keepOpen.add(t.key);
    reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    await whileSaving(reply.thread, () => git.call("addComment", { root: t.root, key: t.key, comment: { author, body: reply.text, createdAt } }));
    renderPath(reply.thread.uri.fsPath);
    syncAfterChange(t.root);
  };

  /** Removes one of your own replies from a note. */
  const deleteComment = async (comment: NoteComment) => {
    const thread = comment.thread;
    if (!thread || !comment.createdAt) return;
    thread.comments = thread.comments.filter((c) => c !== comment); // remove it from view right away
    const removed = await git.call<boolean>("removeComment", { root: comment.root, key: comment.key, index: comment.index, createdAt: comment.createdAt });
    if (!removed) throw new Error("the reply changed in the meantime; refresh and try again");
    renderPath(thread.uri.fsPath);
    syncAfterChange(comment.root);
  };

  /** Deletes a note; invoked from the thread header or from its first comment. */
  const deleteNote = async (target: vscode.CommentThread | NoteComment) => {
    const thread = target instanceof NoteComment ? target.thread : target;
    if (!thread) return;
    const t = threadInfo.get(thread);
    if (!t) return;
    const reason = await vscode.window.showInputBox({ prompt: "Why is this note no longer relevant?", placeHolder: "e.g. fixed in PROJ-123" });
    if (reason === undefined) return;
    const fsPath = thread.uri.fsPath;
    thread.dispose(); // remove it from view right away
    threadsByDoc.get(thread.uri.toString())?.delete(t.key);
    const justification = reason || "deleted in VS Code";
    await git.call("softDelete", { root: t.root, key: t.key, by: await authorOf(t.root), reason: justification });
    log(`deleted note ${t.key}`);
    renderPath(fsPath);
    syncAfterChange(t.root);
    // A note from a GitHub conversation that is still open (asked now, not cached): post the reason there and resolve it.
    if (t.doc.github) {
      try {
        await githubSession(true);
        const states = new ThreadStates(t.root, 0);
        const open = (await states.refresh([t.doc.github.threadId])).get(t.doc.github.threadId) === false;
        if (open) {
          states.set(t.doc.github.threadId, await setThreadResolved(t.doc.github.threadId, true, githubDeletionReply(justification)));
          log(`resolved GitHub conversation of note ${t.key}`);
        }
      } catch (err) {
        log(`resolving on GitHub failed: ${String((err as Error).stack ?? err)}`);
        vscode.window.showWarningMessage(`Code Notes: the note was deleted, but the GitHub conversation could not be resolved: ${(err as Error).message}`);
      }
    }
  };

  const editComment = (comment: NoteComment) => {
    if (!comment.thread) return;
    comment.thread.comments = comment.thread.comments.map((c) =>
      c === comment ? Object.assign(comment, { mode: vscode.CommentMode.Editing, body: comment.savedBody }) : c);
  };

  const saveComment = async (comment: NoteComment) => {
    const thread = comment.thread;
    if (!thread) return;
    const body = typeof comment.body === "string" ? comment.body : comment.body.value;
    comment.savedBody = body;
    thread.comments = thread.comments.map((c) => (c === comment ? Object.assign(comment, { mode: vscode.CommentMode.Preview, label: "saving…" }) : c));
    keepOpen.add(comment.key);
    await whileSaving(thread, () => git.call("editComment", { root: comment.root, key: comment.key, index: comment.index, body }));
    renderPath(thread.uri.fsPath);
    syncAfterChange(comment.root);
  };

  const cancelEdit = (comment: NoteComment) => {
    if (!comment.thread) return;
    comment.thread.comments = comment.thread.comments.map((c) =>
      c === comment ? Object.assign(comment, { mode: vscode.CommentMode.Preview, body: comment.savedBody }) : c);
  };

  // ---- Repo-level commands ----

  const activeRoot = async (): Promise<RepoInfo | null> => {
    const file = vscode.window.activeTextEditor?.document.uri;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const info = file?.scheme === "file" ? await repoFor(file.fsPath) : folder ? await repoFor(join(folder.fsPath, "_")) : null;
    if (!info) vscode.window.showWarningMessage("Code Notes: open a file inside a git repository first.");
    return info;
  };

  const syncNotes = async () => {
    const info = await activeRoot();
    if (!info) return;
    await git.call("remote", { root: info.root }); // throws with instructions when there is no default remote
    const r = await syncRepo(info.root);
    vscode.window.showInformationMessage(r ? `Code Notes: ${r.merged} notes merged from the remote${r.pushed ? "; pushed" : ""}.` : "Code Notes: no remote to sync with.");
    renderAll();
  };

  /** Syncs the notes of every known repository with its remote (pull and push), then re-renders. */
  const refresh = async () => {
    const repos = [...new Map(knownRepos.map((r) => [r.commonDir, r])).values()];
    const results = await Promise.all(repos.map((r) => syncRepo(r.root)));
    const merged = results.reduce((n, r) => n + (r?.merged ?? 0), 0);
    renderAll();
    vscode.window.setStatusBarMessage(`Code Notes: synced${merged ? `, ${merged} notes merged` : ""}`, 3000);
  };

  const importGithub = async () => {
    const info = await activeRoot();
    if (!info) return;
    const token = await githubSession(true);
    const limit = vscode.workspace.getConfiguration("codeNotes").get<number>("importLimit", 300);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Code Notes: importing GitHub review conversations" },
      async (progress) => {
        const r = await git.call<{ added: number; updated: number; skippedDeleted: number }>("importGithub", { root: info.root, token, limit },
          (m) => { log(m); progress.report({ message: m }); });
        vscode.window.showInformationMessage(`Code Notes: ${r.added} notes added, ${r.updated} updated, ${r.skippedDeleted} skipped because deleted.`);
      });
    renderAll();
    syncAfterChange(info.root);
  };

  const register = (id: string, name: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, guarded(name, fn));

  context.subscriptions.push(
    output,
    controller,
    git,
    status,
    decorationsChanged,
    rangeDecoration,
    vscode.window.registerFileDecorationProvider(decorations),
    register("codeNotes.createNote", "saving the note", createNote),
    register("codeNotes.addNote", "adding a note", addNoteOnSelection),
    register("codeNotes.replyNote", "replying", replyNote),
    register("codeNotes.deleteComment", "removing the reply", deleteComment),
    register("codeNotes.deleteNote", "deleting the note", deleteNote),
    register("codeNotes.editComment", "editing", editComment),
    register("codeNotes.saveComment", "saving the edit", saveComment),
    register("codeNotes.cancelEdit", "cancelling the edit", cancelEdit),
    register("codeNotes.resolveOnGithub", "resolving on GitHub", setResolved(true)),
    register("codeNotes.reopenOnGithub", "reopening on GitHub", setResolved(false)),
    register("codeNotes.openOnGithub", "opening GitHub", openOnGithub),
    register("codeNotes.syncNotes", "syncing", syncNotes),
    register("codeNotes.importGithub", "importing", importGithub),
    register("codeNotes.refresh", "refreshing", refresh),
    vscode.window.onDidChangeVisibleTextEditors(visibleChanged),
    // Comment threads move with edits; keep the gutter bars on the same lines.
    vscode.workspace.onDidChangeTextDocument((e) => showRangesFor(e.document)),
    vscode.workspace.onDidCloseTextDocument(clear),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("codeNotes")) return;
      schedulePull();
      renderAll();
    }),
    vscode.window.onDidChangeWindowState((state) => state.focused && pullAll()),
    { dispose: () => clearInterval(pullTimer) },
    { dispose: () => [...refWatchers.values()].flat().forEach((w) => w.close()) },
  );
  // Discover the repos of the workspace folders now (which pulls their notes), not only when a file is opened.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === "file") background("finding the repository", repoFor(join(folder.uri.fsPath, "_")));
  }
  renderAll();
}

/** A new, empty note thread; fillThread() sets its content. Only new threads get the initial collapsed state. */
function createThread(controller: vscode.CommentController, doc: vscode.TextDocument, expand: "none" | "all"): vscode.CommentThread {
  const thread = controller.createCommentThread(doc.uri, new vscode.Range(0, 0, 0, 0), []);
  thread.canReply = true;
  thread.collapsibleState = expand === "all"
    ? vscode.CommentThreadCollapsibleState.Expanded
    : vscode.CommentThreadCollapsibleState.Collapsed;
  return thread;
}

/** Sets what a thread shows for a note; also used to update a thread in place without closing it. */
function fillThread(
  thread: vscode.CommentThread,
  doc: vscode.TextDocument,
  root: string,
  note: FileNote,
  range: Located | null,
  githubResolved?: boolean,
  firstCommentLabel?: string,
): void {
  const lastLine = Math.max(doc.lineCount - 1, 0);
  const start = Math.min((range?.start ?? 1) - 1, lastLine);
  const end = Math.min((range?.end ?? 1) - 1, lastLine);
  const { doc: d } = note;
  const comments = d.comments.map((c, i) => {
    const body = new vscode.MarkdownString(c.body);
    if (i === 0) {
      const footer: string[] = [];
      const original = originalCode(d, range);
      if (original) footer.push(original);
      if (footer.length) body.appendMarkdown(`\n\n---\n${footer.join("\n\n")}`);
    }
    const label = i === 0 && firstCommentLabel ? firstCommentLabel : c.editedAt ? "edited" : undefined;
    // GitHub comments carry the GitHub username, so their avatar can be shown; local comments only have a git identity.
    const author: vscode.CommentAuthorInformation = c.source === "github"
      ? { name: c.author, iconPath: vscode.Uri.parse(`https://avatars.githubusercontent.com/${encodeURIComponent(c.author)}?s=64`) }
      : { name: withoutEmail(c.author) };
    return new NoteComment(body, author, new Date(c.createdAt), root, note.key, i, c.source === "local", label, c.createdAt);
  });
  // Only assign what changed: reassigning an identical range can make VS Code redraw the thread collapsed.
  if (!thread.range || thread.range.start.line !== start || thread.range.end.line !== end) {
    thread.range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
  }
  thread.comments = comments;
  for (const c of comments) c.thread = thread;
  // The header is a status line (where the note sits, where it comes from, its state), not a preview of the
  // first comment, which is shown right below it anyway. A summary, when someone wrote one, is added.
  const match = describeMatch(range, d.anchor);
  const status = [
    describeLines(range),
    d.pr ? `PR #${d.pr.number} ${truncate(d.pr.title, 80)}` : `note by ${withoutEmail(d.comments[0]?.author ?? "unknown")}`,
    d.github && githubResolved !== undefined ? (githubResolved ? "resolved on GitHub" : "open on GitHub") : null,
    match || null,
    note.originalPath ? `was ${note.originalPath}` : null,
    d.comments.length > 1 ? `${d.comments.length - 1} repl${d.comments.length === 2 ? "y" : "ies"}` : null,
  ].filter(Boolean).join(" · ");
  const label = d.summary ? `${status}: ${d.summary}` : status;
  if (thread.label !== label) thread.label = label;
  // The resolve/reopen buttons need the GitHub state; until it is known only "open on GitHub" is offered.
  const contextValue = !d.github ? "codeNote" : githubResolved === undefined ? "codeNote-github" : githubResolved ? "codeNote-github-resolved" : "codeNote-github-open";
  if (thread.contextValue !== contextValue) thread.contextValue = contextValue;
  if (d.github && githubResolved !== undefined) {
    const state = githubResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    if (thread.state !== state) thread.state = state;
  }
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A thin vertical bar, stretched to the full line height so consecutive lines form one continuous bar. */
function gutterBar(color: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" preserveAspectRatio="none"><rect x="5" y="0" width="3" height="16" fill="${color}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

function isWithin(root: string, dir: string): boolean {
  const rel = relative(root, dir);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function deactivate(): void {}
