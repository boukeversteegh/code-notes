import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Resolves `owner/name` from the `origin` remote of the git repo containing `cwd`. */
export function detectRepo(cwd: string): string {
  const url = git(cwd, "remote", "get-url", "origin");
  const match = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) throw new Error(`origin is not a GitHub remote: ${url}`);
  return `${match[1]}/${match[2]}`;
}

/** Top-level directory of the git repo containing `cwd`. */
export function gitRoot(cwd: string): string {
  return git(cwd, "rev-parse", "--show-toplevel");
}

/** Converts a (possibly absolute) file path to the repo-relative, forward-slash form GitHub uses. */
export function toRepoPath(file: string, cwd: string, root = gitRoot(cwd)): string {
  const absolute = isAbsolute(file) ? file : resolve(cwd, file);
  return relative(resolve(root), absolute).split(sep).join("/");
}
