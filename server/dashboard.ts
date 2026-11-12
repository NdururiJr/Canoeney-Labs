// Dashboard commands (spec M0.14, surface S5; threat model SR-C-04 to SR-C-08,
// SR-C-17, SR-C-18; docs/adr/0007-owner-login-and-dashboard.md).
//
// Every command declares the lowest human role that may run it, when it needs
// the approval PIN, and whether a remote session may run it. dispatch() checks
// those in order, writes one audit row per call (before it runs) under the human's own id, and
// answers the socket that sent it. Terminal keystrokes are audited collapsed,
// once per session, agent and minute, and never with the text typed.
import type { OfficeEvent } from "../src/data/source";
import type { AgentConfig, AgentStatus, HqConfig, OfficeSnapshot } from "../src/data/types";
import type { Clock } from "./company/clock";
import type { AuditSink } from "./company/slots/types";
import type { HumanRole } from "./company/types";
import { log } from "./lib/log";
import type { OwnerAuth } from "./ownerAuth";

export interface CommandCtx {
  actor: { kind: "human"; id: string };
  role: HumanRole;
  remote: boolean;
  sessionId: string;
}

export interface CommandSpec {
  /** The lowest role that may run it. */
  role: HumanRole;
  /** Needs the approval PIN: always, or only for some arguments (the approve, grant or relax direction). */
  pin?: boolean | ((args: unknown[]) => boolean);
  /** Refused in a remote session (host shell, terminal, things that open on the host). */
  localOnly?: true;
  /** What the command acts on, for the audit row: an agent id or a name, never a value. */
  target?: (args: unknown[]) => string | null;
  /** "collapsed": one row per session, target and minute, with a count. */
  audit?: "per-call" | "collapsed";
  /** Takes a secret value: no error text from it reaches a reply, the feed or the log. */
  secret?: true;
  run: (ctx: CommandCtx, ...args: unknown[]) => unknown;
}

export type CommandError = "unknown" | "forbidden" | "remote" | "pin-required" | "pin-wrong" | "pin-locked" | "rate-limited" | "failed";
export type CommandResult = { ok: true } | { ok: false; error: CommandError };

interface Message {
  cmd?: unknown;
  args?: unknown;
  pin?: unknown;
  id?: unknown;
}

export interface DashboardLimits {
  /** Messages a connection may send at once, and the refill rate per second. */
  burst: number;
  perSecond: number;
}

const MINUTE = 60_000;
const NAME = /^[A-Za-z]{1,40}$/;

const rank = (r: HumanRole) => (r === "owner" ? 2 : 1);

export class Dashboard {
  private readonly limits: DashboardLimits;
  private collapsed = new Map<string, { start: number; count: number; actor: string; cmd: string; target: string | null }>();

  constructor(
    readonly commands: Record<string, CommandSpec>,
    private readonly o: { ownerAuth: OwnerAuth; audit: AuditSink; clock: Clock; limits?: Partial<DashboardLimits> },
  ) {
    this.limits = { burst: 100, perSecond: 50, ...o.limits };
  }

  /** A per-connection message limiter: true while the connection may send. */
  limiter(): () => boolean {
    let tokens = this.limits.burst;
    let at = this.now();
    return () => {
      const now = this.now();
      tokens = Math.min(this.limits.burst, tokens + ((now - at) / 1000) * this.limits.perSecond);
      at = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };
  }

  /** Writes one dashboard.rate-limited row per connection and minute; returns the minute it last wrote. */
  rateLimited(ctx: CommandCtx, lastRowAt: number | null): number | null {
    const now = this.now();
    if (lastRowAt !== null && now < lastRowAt + MINUTE) return lastRowAt;
    this.append(ctx, "dashboard.rate-limited", null, {});
    return now;
  }

  /** Checks and runs one message. Never throws. */
  async dispatch(ctx: CommandCtx, msg: Message): Promise<CommandResult> {
    const cmd = typeof msg.cmd === "string" ? msg.cmd : "";
    const args = Array.isArray(msg.args) ? msg.args : [];
    const spec = NAME.test(cmd) && Object.hasOwn(this.commands, cmd) ? this.commands[cmd] : undefined;
    const label = NAME.test(cmd) ? cmd : `(${cmd.length} characters)`;
    if (!spec || (spec.role !== "owner" && spec.role !== "supervisor")) return this.refuse(ctx, label, null, "unknown");
    const target = this.targetOf(spec, args);
    if (rank(ctx.role) < rank(spec.role)) return this.refuse(ctx, cmd, target, "forbidden");
    if (spec.localOnly && ctx.remote) return this.refuse(ctx, cmd, target, "remote");
    // A PIN rule that fails asks for the PIN: a check that breaks refuses, it never lets through.
    const needsPin = typeof spec.pin === "function" ? (safe(() => (spec.pin as (a: unknown[]) => boolean)(args)) ?? true) : spec.pin === true;
    if (needsPin) {
      if (msg.pin === undefined || msg.pin === null || msg.pin === "") return this.refuse(ctx, cmd, target, "pin-required");
      let pin: "ok" | "wrong" | "locked";
      try {
        pin = await this.o.ownerAuth.checkPin(ctx.actor.id, msg.pin);
      } catch {
        return this.refuse(ctx, cmd, target, "failed");
      }
      if (pin === "locked") return this.refuse(ctx, cmd, target, "pin-locked");
      if (pin === "wrong") return this.refuse(ctx, cmd, target, "pin-wrong");
    }
    if (spec.audit === "collapsed") this.countCollapsed(ctx, cmd, target);
    else if (!this.tryAppend(ctx, "dashboard.command", target, { cmd, outcome: "run" })) return { ok: false, error: "failed" };
    try {
      await spec.run(ctx, ...args);
      return { ok: true };
    } catch (err) {
      // A failure's text never reaches the reply or the audit row, and for a command that takes a secret not even the log.
      if (spec.secret) log.warn(`command ${cmd} failed`);
      else log.warn(`command ${cmd} failed:`, String(err instanceof Error ? err.message : err).slice(0, 200));
      this.tryAppend(ctx, "dashboard.command-failed", target, { cmd });
      return { ok: false, error: "failed" };
    }
  }

  /** Writes the collapsed rows whose minute is over (or all of them, at the end of a session). */
  flush(all = false): void {
    const now = this.now();
    for (const [key, w] of [...this.collapsed]) {
      if (!all && now < w.start + MINUTE) continue;
      this.collapsed.delete(key);
      try {
        this.o.audit.append({ actorKind: "human", actorId: w.actor, action: "dashboard.terminal", target: w.target, data: { cmd: w.cmd, count: w.count } });
      } catch {
        /* best effort: the keystrokes were already delivered */
      }
    }
  }

  private countCollapsed(ctx: CommandCtx, cmd: string, target: string | null): void {
    this.flush();
    const key = `${ctx.sessionId}\n${cmd}\n${target ?? ""}`;
    const w = this.collapsed.get(key);
    if (w) w.count++;
    else this.collapsed.set(key, { start: this.now(), count: 1, actor: ctx.actor.id, cmd, target });
  }

  private refuse(ctx: CommandCtx, cmd: string, target: string | null, reason: CommandError): CommandResult {
    this.tryAppend(ctx, "dashboard.command", target, { cmd, outcome: "refused", reason });
    return { ok: false, error: reason };
  }

  private targetOf(spec: CommandSpec, args: unknown[]): string | null {
    const t = spec.target ? safe(() => spec.target!(args)) : null;
    return typeof t === "string" && t ? t.slice(0, 80) : null;
  }

  private append(ctx: CommandCtx, action: string, target: string | null, data: Record<string, unknown>): void {
    this.o.audit.append({ actorKind: "human", actorId: ctx.actor.id, action, target, data });
  }

  private tryAppend(ctx: CommandCtx, action: string, target: string | null, data: Record<string, unknown>): boolean {
    try {
      this.append(ctx, action, target, data);
      return true;
    } catch (err) {
      log.warn(`audit write failed for ${action}:`, err instanceof Error ? err.name : "error");
      return false;
    }
  }

  private now(): number {
    return this.o.clock.now().getTime();
  }
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- What a role sees (SR-C-09)

/** Events a supervisor never receives: terminal output and the owner's machine, sandbox and access state. */
const OWNER_ONLY_EVENTS = new Set(["terminal.output", "workspace.info", "sbx.updated", "mcp.updated", "setup.updated", "access.updated"]);

/** A supervisor's view of the team: an explicit keep-list, so a new field is owner-only until it is listed here. */
function teamForSupervisor(team: AgentConfig[]): Partial<AgentConfig>[] {
  return team.map((a) => ({ id: a.id, name: a.name, role: a.role, color: a.color, cli: a.cli, isLead: a.isLead }));
}

function configForSupervisor(c: HqConfig): Partial<HqConfig> {
  return { project: c.project, team: teamForSupervisor(c.team) as AgentConfig[] };
}

/** An agent's status without the host folder its session runs in. */
function statusForSupervisor(s: AgentStatus): AgentStatus {
  return { ...s, session: { ...s.session, workspace: null } };
}

/** The event as the role may see it, or null when it is not sent at all. */
export function viewFor(role: HumanRole, e: OfficeEvent): OfficeEvent | null {
  if (role === "owner") return e;
  if (OWNER_ONLY_EVENTS.has(e.type)) return null;
  switch (e.type) {
    case "snapshot": {
      const s = e.snapshot;
      const kept = {
        welcome: s.welcome,
        config: configForSupervisor(s.config),
        agents: s.agents.map(statusForSupervisor),
        boards: s.boards,
        tasks: s.tasks,
        pullRequests: s.pullRequests,
        environments: s.environments,
        messages: s.messages,
        activity: s.activity,
        actionItems: s.actionItems,
      };
      return { type: "snapshot", snapshot: kept as unknown as OfficeSnapshot };
    }
    case "config.updated":
      return { type: "config.updated", config: configForSupervisor(e.config) as HqConfig };
    case "agent.updated":
      return { type: "agent.updated", agent: statusForSupervisor(e.agent) };
    default:
      return e;
  }
}
