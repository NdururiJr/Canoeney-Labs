// Agent sessions for tests: a session backend that runs nothing, and Local-mode
// agents in their own temporary git repos, on top of the HQ fixture.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../../src/data/types";
import { MCP_CONFIG } from "../agentFiles";
import type { ExitInfo, LaunchSpec, SessionBackend, TermHandle, TermSize } from "../backends/types";
import { Sessions } from "../sessions";
import type { Hq } from "./hqFixture";

/** A session backend that runs nothing: tests say which sessions exist. */
export class FakeBackend implements SessionBackend {
  readonly kind = "tmux" as const;
  readonly persistent = true;
  live = new Set<string>();
  dead = new Set<string>();
  /** Names that look gone to the next exists() only. */
  goneOnce = new Set<string>();
  createThrows = false;
  attachThrows = false;
  async exists(name: string) {
    if (this.goneOnce.delete(name)) return false;
    return this.live.has(name);
  }
  async create(name: string, _cwd: string, _spec: LaunchSpec, _size: TermSize) {
    if (this.createThrows) throw new Error("create failed");
    this.live.add(name);
  }
  async kill(name: string) {
    this.live.delete(name);
    this.dead.delete(name);
  }
  attach(): TermHandle {
    if (this.attachThrows) throw new Error("attach failed");
    return { write() {}, resize() {}, close() {} };
  }
  async type() {
    return true;
  }
  async enter() {
    return true;
  }
  async exitInfo(name: string): Promise<ExitInfo | null> {
    return { dead: this.dead.has(name), exitStatus: this.dead.has(name) ? 1 : null };
  }
  async screenText() {
    return "";
  }
  shutdown() {}
}

function gitRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

/** Sessions on the fixture, with a fake backend and Local-mode agents in their own git repos. */
export function withSessions(t: { after(fn: () => void): void }, hq: Hq, cli: Partial<Record<string, AgentConfig["cli"]>> = {}) {
  hq.hub.snap.setup = {
    ...hq.hub.snap.setup,
    checks: ["tmux", "claude", "codex"].map((id) => ({ id, status: "ok", label: id, detail: "" })),
  } as typeof hq.hub.snap.setup;
  for (const a of hq.hub.snap.config.team) {
    a.mode = "local";
    a.cli = cli[a.id] ?? "claude";
    a.workspacePath = gitRepo(join(hq.scratch, `work ${a.id}`));
  }
  const sessions = new Sessions(hq.hub, hq.company);
  const backend = new FakeBackend();
  (sessions as unknown as { backend: SessionBackend }).backend = backend;
  t.after(() => sessions.shutdown());
  const name = (id: string) => `hq-${hq.slug}-${id}`;
  const fileSecret = (id: string) => {
    const cfg = JSON.parse(readFileSync(join(hq.hub.cfg(id)!.workspacePath!, MCP_CONFIG), "utf8"));
    return String(cfg.mcpServers.hq.headers.Authorization).replace(/^Bearer /, "");
  };
  return { sessions, backend, name, fileSecret };
}
