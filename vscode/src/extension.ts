import { type FSWatcher, existsSync, mkdirSync, statSync, watch } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import * as vscode from "vscode";
import { type Located, buildAnchor } from "../../src/anchor.ts";
import { Cache } from "../../src/cache.ts";
import { describeLines, describeMatch, originalCode, withoutEmail } from "../../src/format.ts";
import { type NoteDoc, NoteStore, keyFor, newManualId } from "../../src/gitnotes.ts";
import { githubDeletionReply, setGithubToken, setThreadResolved } from "../../src/github.ts";
import { ThreadStates } from "../../src/thread-states.ts";
import { importFromCache } from "../../src/importer.ts";
import { type FileNote, RepoNotes, gitDirs } from "../../src/notes.ts";
import { detectRepo, gitRoot, toRepoPath } from "../../src/repo.ts";
import { fetchPrsIntoCache } from "../../src/fetch-prs.ts";
import { placeNotes } from "../../src/tracking.ts";

interface RepoInfo {
  root: string;
  gitDir: string;
  commonDir: string;
}

interface ThreadInfo {
  root: string;
  key: string;
  doc: NoteDoc;
}

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

const mtime = (file: string) => {
  try {
    return String(statSync(file).mtimeMs);
  } catch {
    return "-";
  }
};

/**
 * Notes per checkout, reloaded when the notes ref changes (a write here, in another worktree, by the CLI or
 * by a sync) or when HEAD moves (renames are resolved against HEAD). The notes ref is shared by all
 * worktrees, so it is looked up in the common git dir; HEAD is per worktree.
 */
class NotesCache {
  private loaded = new Map<string, { key: string; notes: RepoNotes }>();

  get(info: RepoInfo): RepoNotes {
    const key = [
      join(info.commonDir, "refs", "notes", "code-notes"),
      join(info.commonDir, "packed-refs"),
      join(info.gitDir, "logs", "HEAD"),
    ].map(mtime).join("|");
    const entry = this.loaded.get(info.root);
    if (entry?.key === key) return entry.notes;
    const notes = RepoNotes.load(info.root);
    this.loaded.set(info.root, { key, notes });
    return notes;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Code Notes");
  const controller = vscode.comments.createCommentController("code-notes", "Code notes");
  const notesCache = new NotesCache();
  /** Rendered threads per document, by note key, with a signature of what they show, so re-renders update in place. */
  const threadsByDoc = new Map<string, Map<string, { thread: vscode.CommentThread; signature: string }>>();
  const threadsOf = (doc: vscode.TextDocument) => [...(threadsByDoc.get(doc.uri.toString())?.values() ?? [])].map((r) => r.thread);
  const threadInfo = new WeakMap<vscode.CommentThread, ThreadInfo>();
  const repoByDir = new Map<string, RepoInfo | null>();
  const knownRepos: RepoInfo[] = [];
  const refWatchers = new Map<string, FSWatcher[]>();
  /** Threads whose GitHub state is being looked up, so a render does not start a second lookup. */
  const lookingUp = new Set<string>();

  const log = (msg: string) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);

  /** Runs a command handler, reporting failures instead of failing silently. */
  const guarded = <A extends unknown[]>(name: string, fn: (...args: A) => unknown) => async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      log(`${name} failed: ${String((err as Error).stack ?? err)}`);
      vscode.window.showErrorMessage(`Code Notes: ${name} failed: ${(err as Error).message}`);
    }
  };

  const repoFor = (filePath: string): RepoInfo | null => {
    const dir = dirname(filePath);
    // Explorer decorations ask about every visible folder; reuse a known root instead of spawning git.
    const known = knownRepos.find((r) => isWithin(r.root, dir));
    if (known) return known;
    if (!repoByDir.has(dir)) {
      try {
        const root = gitRoot(dir);
        const info = { root, ...gitDirs(root) };
        knownRepos.push(info);
        repoByDir.set(dir, info);
        watchNotesRef(info);
        setTimeout(() => new NoteStore(root).author(), 0); // look up the git identity once, before the first reply
        // Pull right away, so a fresh clone shows the shared notes without waiting for the next periodic pull.
        // The ref watcher re-renders when the pull brings notes.
        setTimeout(() => syncRepo(root).catch((err) => log(`pull ${root} failed: ${(err as Error).message}`)), 0);
      } catch {
        repoByDir.set(dir, null);
      }
    }
    return repoByDir.get(dir)!;
  };

  /** Re-renders when the shared notes ref changes, e.g. after a write in another worktree or a CLI sync. */
  const watchNotesRef = (info: RepoInfo) => {
    if (refWatchers.has(info.commonDir)) return;
    const notesDir = join(info.commonDir, "refs", "notes");
    mkdirSync(notesDir, { recursive: true });
    let timer: NodeJS.Timeout | undefined;
    let lastHead = new NoteStore(info.root).head();
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Lock files and rewrites of the same value also trigger the watcher; only a new notes commit matters.
        const head = new NoteStore(info.root).head();
        if (head === lastHead) return;
        lastHead = head;
        renderAll();
      }, 300);
    };
    const watchers = [watch(notesDir, changed)];
    if (existsSync(join(info.commonDir, "packed-refs"))) watchers.push(watch(join(info.commonDir, "packed-refs"), changed));
    refWatchers.set(info.commonDir, watchers);
  };

  const notesFor = (filePath: string): { info: RepoInfo; notes: FileNote[] } | null => {
    const info = repoFor(filePath);
    if (!info) return null;
    return { info, notes: notesCache.get(info).forFile(toRepoPath(filePath, info.root, info.root)) };
  };

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

  const clear = (doc: vscode.TextDocument) => {
    threadsOf(doc).forEach((t) => t.dispose());
    threadsByDoc.delete(doc.uri.toString());
  };

  /**
   * Shows the notes of a document. Threads are matched to notes by key: unchanged notes keep their thread
   * untouched (so an open note stays open), changed notes are updated in place, and only new or removed
   * notes create or dispose threads.
   */
  const render = (doc: vscode.TextDocument) => {
    const uri = doc.uri.toString();
    const previous = threadsByDoc.get(uri) ?? new Map<string, { thread: vscode.CommentThread; signature: string }>();
    const next = new Map<string, { thread: vscode.CommentThread; signature: string }>();
    const found = doc.uri.scheme === "file" ? notesFor(doc.uri.fsPath) : null;
    if (found && found.notes.length > 0) {
      const lines = doc.getText().split(/\r?\n/);
      const placed = placeNotes(found.info.root, found.notes.map((n) => n.doc), lines);
      const expand = vscode.workspace.getConfiguration("codeNotes").get<"none" | "all">("expand", "none");
      const states = new ThreadStates(found.info.root);
      found.notes.forEach((note, i) => {
        const resolved = note.doc.github ? states.get(note.doc.github.threadId) : undefined;
        const signature = JSON.stringify([note.doc, placed[i], resolved, note.originalPath]);
        const old = previous.get(note.key);
        if (old?.signature === signature) {
          next.set(note.key, old);
          return;
        }
        const thread = old?.thread ?? createThread(controller, doc, expand);
        fillThread(thread, doc, found.info.root, note, placed[i], resolved);
        threadInfo.set(thread, { root: found.info.root, key: note.key, doc: note.doc });
        next.set(note.key, { thread, signature });
      });
      refreshGithubStates(found.info.root, found.notes, doc.uri.fsPath);
    }
    for (const [key, r] of previous) if (!next.has(key)) r.thread.dispose();
    if (next.size) threadsByDoc.set(uri, next);
    else threadsByDoc.delete(uri);
    showRangesFor(doc);
  };

  /** Re-renders the open documents of one file path, e.g. after a write. */
  const renderPath = (fsPath: string) => {
    vscode.workspace.textDocuments.filter((d) => d.uri.fsPath === fsPath).forEach(render);
    decorationsChanged.fire(vscode.Uri.file(fsPath));
  };

  // VS Code only requests decorations for items rendered in the Explorer (and open tabs).
  const decorationsChanged = new vscode.EventEmitter<vscode.Uri | undefined>();
  const decorations: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: decorationsChanged.event,
    provideFileDecoration(uri) {
      if (uri.scheme !== "file") return;
      const info = repoFor(uri.fsPath);
      const count = info ? notesCache.get(info).count(toRepoPath(uri.fsPath, info.root, info.root)) : 0;
      if (!count) return;
      return new vscode.FileDecoration("💬", `${count} code note${count === 1 ? "" : "s"}`);
    },
  };

  const renderAll = () => {
    vscode.workspace.textDocuments.forEach(render);
    decorationsChanged.fire(undefined);
  };

  // Every line of a file in a git repo can get a new note.
  controller.commentingRangeProvider = {
    provideCommentingRanges: (doc) =>
      doc.uri.scheme === "file" && repoFor(doc.uri.fsPath) ? [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)] : [],
  };
  controller.options = { placeHolder: "Write a code note…", prompt: "Add a code note" };

  // ---- GitHub ----

  const githubSession = async (interactive: boolean) => {
    const session = await vscode.authentication.getSession("github", ["repo"], interactive ? { createIfNone: true } : { silent: true });
    if (session) setGithubToken(session.accessToken);
    return !!session;
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

  // ---- Sync ----

  /** Pushes and pulls notes in the background after a change, when enabled and a remote is configured. */
  const syncAfterChange = (root: string) => {
    if (!vscode.workspace.getConfiguration("codeNotes").get<boolean>("syncOnChange", true)) return;
    syncRepo(root).catch((err) => log(`sync ${root} failed: ${(err as Error).message}`));
  };

  /** Running sync per repo; a change made while one runs queues exactly one follow-up sync. */
  const syncing = new Map<string, Promise<{ fetched: boolean; merged: number; pushed: boolean } | null>>();
  const queued = new Set<string>();
  /** Background sync of one repo; the network steps do not block the extension host. */
  const syncRepo = async (root: string): Promise<{ fetched: boolean; merged: number; pushed: boolean } | null> => {
    const store = new NoteStore(root);
    if (!store.defaultRemote()) return null; // no remote: notes stay local
    const running = syncing.get(root);
    if (running) {
      if (queued.has(root)) return running;
      queued.add(root);
      await running.catch(() => {});
      queued.delete(root);
      return syncRepo(root);
    }
    const run = store.syncAsync().then((r) => {
      if (r.merged || r.pushed) log(`sync ${root}: merged ${r.merged}, pushed ${r.pushed}`);
      return r;
    });
    syncing.set(root, run);
    try {
      return await run;
    } finally {
      syncing.delete(root);
    }
  };

  /** Pulls notes for every repo seen so far: when the window gains focus and every `codeNotes.pullInterval` seconds. */
  const pullAll = () => {
    for (const info of new Map(knownRepos.map((r) => [r.commonDir, r])).values()) {
      syncRepo(info.root).catch((err) => log(`pull ${info.root} failed: ${(err as Error).message}`));
    }
  };
  let pullTimer: NodeJS.Timeout | undefined;
  const schedulePull = () => {
    clearInterval(pullTimer);
    const seconds = vscode.workspace.getConfiguration("codeNotes").get<number>("pullInterval", 60);
    if (seconds > 0) pullTimer = setInterval(pullAll, seconds * 1000);
  };
  schedulePull();

  // ---- Writing ----

  const createNote = (reply: vscode.CommentReply) => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === reply.thread.uri.toString());
    const info = repoFor(reply.thread.uri.fsPath);
    if (!doc) throw new Error("the document of this note is not open");
    if (!info) throw new Error(`${reply.thread.uri.fsPath} is not inside a git repository`);
    const store = new NoteStore(info.root);
    const path = toRepoPath(reply.thread.uri.fsPath, info.root, info.root);
    const lines = doc.getText().split(/\r?\n/);
    let anchor;
    if (reply.thread.range) {
      // A note covers the selected lines. A selection that ends at the start of a line does not include that line.
      const { start: from, end: to } = reply.thread.range;
      const start = from.line + 1;
      const end = Math.max(start, to.character === 0 && to.line > from.line ? to.line : to.line + 1);
      anchor = buildAnchor(lines, start, end, doc.isDirty ? null : store.git(["rev-parse", "HEAD"]).trim());
    } else {
      anchor = { commit: null, startLine: null, endLine: null, text: null }; // a note on the whole file
    }
    const id = newManualId(), now = new Date().toISOString(), key = keyFor(id);
    const note: NoteDoc = {
      schema: 1, id, source: "manual", path, anchor,
      summary: null, comments: [{ author: store.author(), body: reply.text, createdAt: now, source: "local" }],
      pr: null, createdAt: now, updatedAt: now, deleted: null, restoredAt: null,
    };
    // Show the note right away; writing it to git notes and syncing follow in the background.
    reply.thread.dispose();
    const range = anchor.endLine ? { start: anchor.startLine!, end: anchor.endLine, match: "exact" as const } : null;
    const shown = createThread(controller, doc, "all");
    fillThread(shown, doc, info.root, { key, doc: note, originalPath: null }, range);
    threadInfo.set(shown, { root: info.root, key, doc: note });
    const rendered = threadsByDoc.get(doc.uri.toString()) ?? new Map();
    rendered.set(key, { thread: shown, signature: "" });
    threadsByDoc.set(doc.uri.toString(), rendered);
    showRangesFor(doc);
    setTimeout(guarded("saving the note", () => {
      store.put(key, `code-notes: add note on ${path}`, () => note);
      log(`added note ${key} on ${path}:${describeLines(range)}`);
      renderPath(doc.uri.fsPath);
      syncAfterChange(info.root);
    }), 0);
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

  const replyNote = (reply: vscode.CommentReply) => {
    const t = threadInfo.get(reply.thread);
    if (!t) return;
    const store = new NoteStore(t.root);
    const author = store.author();
    const createdAt = new Date().toISOString();
    // Show the reply right away and return, so the reply box clears; writing and syncing follow in the background.
    const shown = new NoteComment(reply.text, { name: withoutEmail(author) }, new Date(createdAt), t.root, t.key, reply.thread.comments.length, true, undefined, createdAt);
    shown.thread = reply.thread;
    reply.thread.comments = [...reply.thread.comments, shown];
    setTimeout(guarded("saving the reply", () => {
      store.addComment(t.key, { author, body: reply.text, createdAt });
      renderPath(reply.thread.uri.fsPath);
      syncAfterChange(t.root);
    }), 0);
  };

  /** Removes one of your own replies from a note. */
  const deleteComment = (comment: NoteComment) => {
    const thread = comment.thread;
    if (!thread || !comment.createdAt) return;
    thread.comments = thread.comments.filter((c) => c !== comment); // remove it from view right away
    setTimeout(guarded("removing the reply", () => {
      if (!new NoteStore(comment.root).removeComment(comment.key, comment.index, comment.createdAt!)) {
        throw new Error("the reply changed in the meantime; refresh and try again");
      }
      renderPath(thread.uri.fsPath);
      syncAfterChange(comment.root);
    }), 0);
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
    const store = new NoteStore(t.root);
    const justification = reason || "deleted in VS Code";
    store.softDelete(t.key, store.author(), justification);
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

  const saveComment = (comment: NoteComment) => {
    if (!comment.thread) return;
    const body = typeof comment.body === "string" ? comment.body : comment.body.value;
    comment.savedBody = body;
    comment.thread.comments = comment.thread.comments.map((c) => (c === comment ? Object.assign(comment, { mode: vscode.CommentMode.Preview }) : c));
    new NoteStore(comment.root).editComment(comment.key, comment.index, body);
    renderPath(comment.thread.uri.fsPath);
    syncAfterChange(comment.root);
  };

  const cancelEdit = (comment: NoteComment) => {
    if (!comment.thread) return;
    comment.thread.comments = comment.thread.comments.map((c) =>
      c === comment ? Object.assign(comment, { mode: vscode.CommentMode.Preview, body: comment.savedBody }) : c);
  };

  // ---- Repo-level commands ----

  const activeRoot = (): RepoInfo | null => {
    const file = vscode.window.activeTextEditor?.document.uri;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const info = file?.scheme === "file" ? repoFor(file.fsPath) : folder ? repoFor(join(folder.fsPath, "_")) : null;
    if (!info) vscode.window.showWarningMessage("Code Notes: open a file inside a git repository first.");
    return info;
  };

  const syncNotes = async () => {
    const info = activeRoot();
    if (!info) return;
    new NoteStore(info.root).remote(); // throws with instructions when there is no default remote
    const r = await syncRepo(info.root);
    vscode.window.showInformationMessage(r ? `Code Notes: ${r.merged} notes merged from the remote${r.pushed ? "; pushed" : ""}.` : "Code Notes: a sync is already running.");
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
    const info = activeRoot();
    if (!info) return;
    const config = vscode.workspace.getConfiguration("codeNotes");
    const store = new NoteStore(info.root);
    const configured = store.git(["config", "--default", "", "--get", "code-notes.github"]).trim();
    const cache = new Cache(configured || detectRepo(info.root));
    await githubSession(true);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Code Notes: importing ${cache.repo}` },
      async (progress) => {
        await fetchPrsIntoCache(cache, { limit: config.get("importLimit", 300), full: false, log: (m) => { log(m); progress.report({ message: m }); } });
        const r = importFromCache(store, cache.readPrs());
        vscode.window.showInformationMessage(
          `Code Notes: ${r.added} notes added, ${r.updated} updated, ${r.skippedDeleted} skipped because deleted.`);
      });
    renderAll();
    syncAfterChange(info.root);
  };

  const register = (id: string, name: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, guarded(name, fn));

  context.subscriptions.push(
    output,
    controller,
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
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach(showRanges)),
    // Comment threads move with edits; keep the gutter bars on the same lines.
    vscode.workspace.onDidChangeTextDocument((e) => showRangesFor(e.document)),
    vscode.workspace.onDidOpenTextDocument(render),
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
    if (folder.uri.scheme === "file") repoFor(join(folder.uri.fsPath, "_"));
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
      if (d.github) footer.push(`[Open conversation on GitHub](${d.github.url}) · PR #${d.pr?.number} ${d.pr?.title ?? ""}`);
      else if (d.pr) footer.push(`[PR #${d.pr.number}](${d.pr.url}) ${d.pr.title}`);
      if (footer.length) body.appendMarkdown(`\n\n---\n${footer.join("\n\n")}`);
    }
    return new NoteComment(body, { name: withoutEmail(c.author) }, new Date(c.createdAt), root, note.key, i, c.source === "local",
      c.editedAt ? "edited" : undefined, c.createdAt);
  });
  thread.range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
  thread.comments = comments;
  for (const c of comments) c.thread = thread;
  const heading = d.summary ?? d.comments[0]?.body.split(/\r?\n/)[0].slice(0, 100) ?? "";
  const match = describeMatch(range, d.anchor);
  const githubState = d.github && githubResolved !== undefined ? ` · ${githubResolved ? "resolved" : "open"} on GitHub` : "";
  thread.label = `${describeLines(range)}${match ? ` (${match})` : ""}${note.originalPath ? ` · was ${note.originalPath}` : ""}${githubState}: ${heading}`;
  // The resolve/reopen buttons need the GitHub state; until it is known only "open on GitHub" is offered.
  thread.contextValue = !d.github ? "codeNote" : githubResolved === undefined ? "codeNote-github" : githubResolved ? "codeNote-github-resolved" : "codeNote-github-open";
  if (d.github && githubResolved !== undefined) thread.state = githubResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
}

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
