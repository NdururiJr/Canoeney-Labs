// Facts about the repo HQ was started in.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { githubOf, remoteUrls } from "./hqSource";
import { run } from "./lib/exec";

export interface RepoInfo {
  root: string;
  name: string;
  originUrl: string | null;
  github: string | null; // "owner/name" when origin is GitHub
  /** owner/name of every GitHub remote, origin or not (SR-D-05 checks them all). */
  remotes: string[];
  hasCodeRabbit: boolean;
  hasInsta: boolean;
}

export async function detectRepo(start: string): Promise<RepoInfo> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: start });
  if (!top.ok) throw new Error(`${start} is not inside a git repository. Run HQ from your project folder or pass --repo <path>.`);
  const root = top.stdout.trim();
  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: root });
  const originUrl = origin.ok ? origin.stdout.trim() : null;
  return {
    root,
    name: basename(root),
    originUrl,
    github: originUrl ? githubOf(originUrl) : null,
    remotes: (await remoteUrls(root)).map(githubOf).filter((g): g is string => g !== null),
    hasCodeRabbit: existsSync(join(root, ".coderabbit.yaml")) || existsSync(join(root, ".coderabbit.yml")),
    hasInsta: existsSync(join(root, ".insta")),
  };
}
