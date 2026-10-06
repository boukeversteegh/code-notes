# code-notes

Code notes are conversations attached to lines of code, stored in git notes so they travel with the repository. Past GitHub PR review conversations can be imported as notes; developers and agents add their own notes and delete the ones that are no longer relevant. A deleted note stays deleted: a later GitHub import skips it, and a sync spreads the deletion to every other clone.

The `code-notes` CLI and the VS Code extension in `vscode/` read and write the same notes.

## Install

Requirements: Node.js 20+, git, [Task](https://taskfile.dev), and for the extension VS Code with the `code` command on PATH.

```sh
task install            # the `code-notes` command and the VS Code extension
task install:cli        # only the command
task install:vscode     # only the extension
task uninstall
```

`task install:cli` links the command globally (`npm link`), so source edits apply immediately. `task install:vscode` builds `vscode/code-notes.vsix` and installs it; run **Developer: Reload Window** in open VS Code windows afterwards.

## Usage

```sh
# Notes (inside a checkout, or pass --cwd)
code-notes show    <file> [--lines A-B] [--json]   # live notes on a file, with their keys
code-notes add     <file> --lines A-B -m TEXT
code-notes comment <key> -m TEXT
code-notes delete  <key> --reason TEXT [--resolve-on-github]
code-notes restore <key>
code-notes sync-notes [--remote NAME]              # fetch, merge and push refs/notes/code-notes

# GitHub import
code-notes sync                                    # PR review conversations -> local cache
code-notes import                                  # cache -> notes (closed and merged PRs)
```

Sharing notes needs a remote for them: `git config code-notes.remote <remote>`. Without it, notes stay local, so they are never pushed anywhere by accident. The GitHub repository for `sync`/`import` comes from `--repo owner/name`, `git config code-notes.github owner/name`, or the `origin` remote; the GitHub token from `GITHUB_TOKEN`/`GH_TOKEN` or `gh auth token`.

To follow imported notes through history exactly (see "Placing notes"), fetch the PR branches once:

```sh
git fetch https://github.com/<owner>/<repo>.git '+refs/pull/*/head:refs/code-notes/pull/*'
```

## VS Code extension

- Notes appear as comment threads on their lines and in the Comments panel. A bar in the gutter marks the lines a note covers, and files with notes get a 💬 badge in the Explorer.
- Add a note with the `+` in the gutter or **Add code note** in the editor context menu; select several lines for a multi-line note. Reply, edit your own comments, or delete a note with the trash icon (you are asked for a reason).
- Imported notes link to their GitHub conversation, show whether it is open or resolved on GitHub, and can resolve or reopen it. Deleting a note whose conversation is still open posts your reason on GitHub and resolves the conversation; a note from a resolved conversation is only removed locally.
- Changes are synced right away (`codeNotes.syncOnChange`), and notes from other clones are pulled when the window gains focus and every `codeNotes.pullInterval` seconds (default 60).
- Commands: **Code Notes: Sync notes with remote**, **Import GitHub review conversations into notes**, **Reload notes**.

## Storage

- All notes live on `refs/notes/code-notes`, in the standard git notes layout. Each note is a JSON document (`NoteDoc` in `src/gitnotes.ts`): path, anchor, comments, PR and GitHub thread reference, timestamps, and a `deleted` tombstone.
- A note's key object is the git blob id of a stable id string: `github-review-thread:<GitHub thread id>` for imported conversations and `manual:<uuid>` for typed notes. Every clone computes the same key for the same GitHub conversation, so imports in different clones converge.
- Worktrees share refs, so a note written in one worktree is visible in all worktrees of the repository without syncing.

## Deletion and sync

- `delete` keeps the document and sets `deleted: {at, by, reason}`; `restore` undoes it. `import` never touches a deleted note, so a deleted GitHub conversation does not come back after a re-import. Comments added locally to an imported note survive re-imports.
- `sync-notes` fetches the remote's notes ref, merges per note, commits with both parents, and pushes. Content follows the later `updatedAt`; the deleted/restored state follows the later delete or restore event, so an edit made without knowing about a deletion cannot undo it.
- Ref updates are compare-and-swap; concurrent writers and racing pushes retry.

## Placing notes

A note stores the commit it was written against, its line range, and the anchored lines with up to three lines of context (for imported notes, taken from the GitHub diff hunk).

1. **Git tracking.** When the anchor commit exists locally, the file at that commit is diffed against the current text, and the lines are mapped exactly. If they were edited since, the note is marked "code changed since" and shows the original code, like GitHub does for outdated comments.
2. **Context matching.** Otherwise the note is placed like `patch` applies a hunk: the full block nearest to the stored position, then with less context (fuzz), then the best partial match with similar lines.

Notes follow renamed files through `git log -M` on `HEAD`. A per-worktree index (`<git-dir>/code-notes/notes-index.json`) maps current paths to note keys and is updated incrementally when the notes ref or `HEAD` changes.

## Tests

`task test` runs the unit tests for anchoring and git tracking, and an end-to-end test against a throwaway repository with a local bare remote, two clones and a worktree.

## Classifiers (experimental)

`code-notes classify` and `report` can label cached GitHub conversations with Claude Haiku (through `claude -p`) or with decision models on OpenRouter (`--classifier jev|mercury`, needs `OPENROUTER_API_KEY`). The import does not use them: deciding relevance is left to the developers and agents who read the notes.

## Known limitations

- Merging is per note: when two clones edit the same note concurrently, the later edit wins as a whole.
- Notes on files that were deleted (not renamed) are not shown.
- An incremental `sync` stops at the first unchanged PR; reaching further back needs `--full --limit N`.
