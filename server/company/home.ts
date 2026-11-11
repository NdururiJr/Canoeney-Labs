import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** HQ's per-user folder name under the home directory. M0-H renames it. */
export const HQ_DIRNAME = ".jsmhq";

/** slugify only emits [a-z0-9-], so no project slug can collide with this. */
export const COMPANY_DIRNAME = "_company";

/**
 * Where the company store lives: outside every repo and every agent folder.
 * HQ_COMPANY_HOME overrides it (tests, the smoke test). Created 0700.
 */
export function companyHome(): string {
  const dir = process.env.HQ_COMPANY_HOME || join(homedir(), HQ_DIRNAME, COMPANY_DIRNAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
