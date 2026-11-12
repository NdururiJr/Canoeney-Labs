// An HQ with the real dashboard command table, for M0-C's command tests.
// Sessions and sbx are stubs that record what they were asked to do; the MCP
// registry is the real SbxMcp with a fake `sbx` runner, so its own failure
// lines are what the tests see.
import type { TestContext } from "node:test";
import type { WebSocket } from "ws";
import { makeCommands } from "../commands";
import type { RunResult } from "../lib/exec";
import type { Sbx } from "../sbx";
import { SbxMcp } from "../sbxMcp";
import type { Sessions } from "../sessions";
import { makeHq, openWs, ORIGIN, OWNER_PIN, type Hq } from "./hqFixture";

export interface Call {
  name: string;
  args: unknown[];
}

export interface DashboardHq {
  hq: Hq;
  /** Every call made to the stub sessions, sbx and the fake sbx runner. */
  calls: Call[];
  /** When set, the stub sbx and the fake runner fail with this text. */
  failWith: { text: string | null };
  /** Opens a socket for a logged-in owner or supervisor. */
  connect(who?: "owner" | "supervisor", headers?: Record<string, string>): Promise<Client>;
}

export interface Client {
  ws: WebSocket;
  /** Every frame received, parsed. */
  frames: Record<string, unknown>[];
  /** Sends a command and waits for its `command.result`. */
  send(cmd: string, args?: unknown[], pin?: string): Promise<{ ok: boolean; error?: string }>;
  /** Sends a raw message without waiting. */
  raw(msg: unknown): void;
  close(): void;
}

let seq = 0;

function stubSessions(calls: Call[]): Sessions {
  const record =
    (name: string, result: unknown = undefined) =>
    (...args: unknown[]) => {
      calls.push({ name: `sessions.${name}`, args });
      return Promise.resolve(result);
    };
  return new Proxy({ removeResources: record("removeResources", []), backend: { persistent: false } } as Record<string, unknown>, {
    get: (target, name) => (name in target ? target[name as string] : record(String(name))),
  }) as unknown as Sessions;
}

function stubSbx(calls: Call[], failWith: { text: string | null }): Sbx {
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push({ name: `sbx.${name}`, args });
      if (failWith.text) throw new Error(failWith.text);
    };
  return new Proxy({ ensureEnvFile: () => "env-file" } as Record<string, unknown>, {
    get: (target, name) => (name in target ? target[name as string] : record(String(name))),
  }) as unknown as Sbx;
}

export async function makeDashboardHq(t: TestContext): Promise<DashboardHq> {
  const calls: Call[] = [];
  const failWith = { text: null as string | null };
  const exec = async (cmd: string, args: string[], opts: { input?: string } = {}): Promise<RunResult> => {
    calls.push({ name: `run.${cmd}`, args: [...args, opts.input ?? ""] });
    if (failWith.text) return { ok: false, code: 1, stdout: "", stderr: `error: ${failWith.text}` };
    return { ok: true, code: 0, stdout: args.includes("ls") ? "[]" : "", stderr: "" };
  };
  const hq = await makeHq(t, {
    commands: (p) => {
      const mcp = new SbxMcp(p.hub, (id, file, args) => calls.push({ name: "runTerminal", args: [id, file, ...args] }), exec);
      return makeCommands(p.hub, stubSessions(calls), p.planner, p.inbox, stubSbx(calls, failWith), mcp, p.company);
    },
  });
  const connect: DashboardHq["connect"] = async (who = "owner", headers = {}) => {
    const cookie = await hq.sessionCookie(who, headers);
    const { ws } = await openWs(hq, { cookie, origin: ORIGIN, ...headers });
    if (!ws) throw new Error("socket refused");
    const frames: Record<string, unknown>[] = [];
    ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
    return {
      ws,
      frames,
      send: (cmd, args = [], pin) =>
        new Promise((resolve, reject) => {
          const id = `c${++seq}`;
          const timer = setTimeout(() => reject(new Error(`no result for ${cmd}`)), 15_000);
          const onMessage = (raw: unknown) => {
            const e = JSON.parse(String(raw)) as { type?: string; id?: string; ok: boolean; error?: string };
            if (e.type !== "command.result" || e.id !== id) return;
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve({ ok: e.ok, ...(e.error ? { error: e.error } : {}) });
          };
          ws.on("message", onMessage);
          ws.send(JSON.stringify({ cmd, args, id, ...(pin !== undefined ? { pin } : {}) }));
        }),
      raw: (msg) => ws.send(typeof msg === "string" ? msg : JSON.stringify(msg)),
      close: () => ws.close(),
    };
  };
  return { hq, calls, failWith, connect };
}

export { OWNER_PIN };
