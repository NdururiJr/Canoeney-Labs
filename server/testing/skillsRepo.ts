// A skills repo for tests: a local bare repo whose commits are built from a
// file map with git's plumbing (hash-object, mktree, commit-tree), never from
// a checkout. `git mktree` takes any entry name, so a test can write trees the
// index refuses: a raw `..` folder, a name holding `\`, or two names that
// differ only in case. Entries can be links (mode 120000) or submodules
// (mode 160000), and a commit can go under any ref, such as refs/pull/1/head.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type FixtureFile =
  | string
  | Buffer
  | { data: string | Buffer; mode?: "100644" | "100755" }
  | { link: string }
  | { submodule: string };

/** Paths (split on `/`) to files. */
export type FixtureFiles = Record<string, FixtureFile>;

export interface SkillsRepoFixture {
  /** The bare repo's folder; also its URL (a local path). */
  dir: string;
  url: string;
  /**
   * Writes a commit holding exactly `files` and points `ref` at it (default
   * the repo's default branch). Its parent is `parent`, or else the ref's current commit.
   */
  commit(files: FixtureFiles, opts?: { ref?: string; parent?: string; message?: string }): string;
}

function git(cwd: string, args: string[], input?: string | Buffer): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, input, stdio: ["pipe", "pipe", "pipe"] })
    .toString()
    .trim();
}

type Node = { dir: Map<string, Node> } | { file: FixtureFile };

/** Makes a bare repo at `<parent>/<name>` whose HEAD names `branch`. */
export function makeSkillsRepo(parent: string, name = "skills-origin.git", branch = "main"): SkillsRepoFixture {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "--bare", `--initial-branch=${branch}`]);

  // One git call per distinct content, so a skill of 257 equal files stays quick.
  const blobs = new Map<string, string>();
  const blob = (data: string | Buffer): string => {
    const key = Buffer.from(data).toString("base64");
    let oid = blobs.get(key);
    if (!oid) blobs.set(key, (oid = git(dir, ["hash-object", "-w", "--no-filters", "--stdin"], data)));
    return oid;
  };

  const writeTree = (d: Map<string, Node>): string => {
    let input = "";
    for (const [n, v] of d) {
      if ("file" in v) {
        const f = v.file;
        if (typeof f === "string" || Buffer.isBuffer(f)) {
          input += `100644 blob ${blob(f)}\t${n}\0`;
        } else if ("link" in f) {
          input += `120000 blob ${blob(f.link)}\t${n}\0`;
        } else if ("submodule" in f) {
          input += `160000 commit ${f.submodule}\t${n}\0`;
        } else {
          input += `${f.mode ?? "100644"} blob ${blob(f.data)}\t${n}\0`;
        }
      } else {
        input += `040000 tree ${writeTree(v.dir)}\t${n}\0`;
      }
    }
    // --missing: a submodule's commit is not in this repo.
    return git(dir, ["mktree", "-z", "--missing"], input);
  };

  return {
    dir,
    url: dir,
    commit(files, opts = {}) {
      const root = new Map<string, Node>();
      for (const [path, f] of Object.entries(files)) {
        const parts = path.split("/");
        let cur = root;
        for (const p of parts.slice(0, -1)) {
          let next = cur.get(p);
          if (!next) cur.set(p, (next = { dir: new Map() }));
          if (!("dir" in next)) throw new Error(`fixture: ${p} is both a file and a folder`);
          cur = next.dir;
        }
        cur.set(parts[parts.length - 1], { file: f });
      }
      const tree = writeTree(root);
      const ref = opts.ref ?? `refs/heads/${branch}`;
      let parent = opts.parent;
      if (parent === undefined) {
        try {
          parent = git(dir, ["rev-parse", "--verify", "-q", ref]);
        } catch {
          parent = undefined;
        }
      }
      const sha = git(dir, ["commit-tree", tree, "-m", opts.message ?? "skills", ...(parent ? ["-p", parent] : [])]);
      git(dir, ["update-ref", ref, sha]);
      return sha;
    },
  };
}
