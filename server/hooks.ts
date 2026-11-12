// Claude Code / Codex hooks → agent state. Each agent's hooks POST to
// /hook/<agentId>/<Event> with the hook's JSON payload, authenticated by the
// agent's own secret (server/agentAuth.ts).
//
// Hook input is untrusted (threat model SR-B-19, SR-B-20): it comes from the
// agent's own process, so it only ever changes how the dashboard shows that
// agent. It decides nothing, and every string in it is cleaned and flagged as
// agent text before it is stored or shown.

import type { Company } from "./company";
import { companyAgentId } from "./company/agents";
import type { Hub } from "./hub";
import type { Inbox } from "./inbox";

/** What HQ reads from a hook payload. Anything in it may be any type: it is cleaned first. */
interface HookPayload {
  prompt?: unknown;
  tool_name?: unknown;
  message?: unknown;
  notification_type?: unknown;
}

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ANSI escape sequences (CSI and OSC), removed whole so no "[31m" is left behind.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
// C0 and C1 control characters, DEL included.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Text an agent sent, made safe to store and show: a non-string becomes "",
 * control characters are removed, whitespace is collapsed, and the result is
 * cut to `max` characters (the last one "…" when cut).
 */
export function cleanAgentText(s: unknown, max = 200): string {
  if (typeof s !== "string") return "";
  const text = s
    .slice(0, max * 4) // bound the work on a huge input
    .replace(ANSI, "")
    .replace(/[\t\n\r\v\f]/g, " ")
    .replace(CONTROL, "")
    .replace(/\s+/g, " ")
    .trim();
  return clip(text, max);
}

/**
 * Whether the agent is inside a turn (prompt submitted, no Stop yet). Hooks can
 * arrive late or out of order (e.g. a PreToolUse after Stop), so only a new prompt
 * may turn an idle agent back to "working".
 */
const turnOpen = new Map<string, boolean>();

export interface HookResult {
  ok: boolean;
  /** JSON printed by the hook command; Claude Code acts on it (Stop: block = continue). */
  response?: Record<string, unknown>;
}

/** Audited hook events, recorded as best effort: they report state, they decide nothing. */
function record(company: Company, hub: Hub, agentId: string, event: string, data: Record<string, unknown> = {}) {
  try {
    company.audit.append({ actorKind: "agent", actorId: companyAgentId(hub.slug, agentId), action: `hook.${event}`, data: { bestEffort: true, ...data } });
  } catch {
    /* a hook never fails because its row could not be written */
  }
}

export function handleHook(hub: Hub, inbox: Inbox, company: Company, agentId: string, event: string, payload: HookPayload): HookResult {
  const st = hub.status(agentId);
  const name = hub.name(agentId);
  if (!st) return { ok: false };
  inbox.noteHook(agentId, event);
  const body = {
    prompt: cleanAgentText(payload?.prompt),
    toolName: cleanAgentText(payload?.tool_name, 64),
    message: cleanAgentText(payload?.message),
    notificationType: cleanAgentText(payload?.notification_type, 64),
  };
  const agentText = { agentText: true as const };

  switch (event) {
    case "SessionStart":
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Ready" });
      record(company, hub, agentId, event);
      break;
    case "UserPromptSubmit":
      turnOpen.set(agentId, true);
      hub.setStatus(agentId, body.prompt ? { state: "working", note: clip(body.prompt), noteIsAgentText: true } : { state: "working", note: null });
      if (st.state !== "working") hub.activity("task.started", agentId, `${name} is working`);
      break;
    case "PreToolUse":
      // Stale: the turn already ended. (Unknown, e.g. after an HQ restart, is allowed.)
      if (turnOpen.get(agentId) === false) break;
      // Also clears "needs input" once a permission prompt is answered.
      if (st.state !== "working" || st.note?.startsWith("Asking"))
        hub.setStatus(agentId, body.toolName ? { state: "working", note: `Using ${body.toolName}`, noteIsAgentText: true } : { state: "working", note: null });
      break;
    case "PostToolUse":
      // A tool finished: if it was waiting on the user (a question or a permission), they answered.
      if (turnOpen.get(agentId) === false) break;
      if (st.state === "needs-input") hub.setStatus(agentId, { state: "working", note: "Continuing after your answer" });
      break;
    case "PermissionRequest": {
      // Codex: an approval prompt is waiting in the terminal.
      if (body.toolName) {
        hub.setStatus(agentId, { state: "needs-input", note: `Asking: Approve ${body.toolName}?`, noteIsAgentText: true });
        hub.activity("agent.needs-input", agentId, `${name} needs you: Approve ${body.toolName}?`, agentText);
      } else {
        hub.setStatus(agentId, { state: "needs-input", note: "Asking: Approval needed in the terminal" });
        hub.activity("agent.needs-input", agentId, `${name} needs you: Approval needed in the terminal`);
      }
      break;
    }
    case "Notification": {
      // "Waiting for your input" fires after a finished turn sits idle — not urgent.
      if (/waiting for your input/i.test(body.message) || body.notificationType === "idle_prompt") {
        hub.setStatus(agentId, { state: "idle", note: "Waiting for you" });
        break;
      }
      if (body.message) {
        hub.setStatus(agentId, { state: "needs-input", note: `Asking: ${clip(body.message)}`, noteIsAgentText: true });
        hub.activity("agent.needs-input", agentId, `${name} needs you: ${clip(body.message, 60)}`, agentText);
      } else {
        hub.setStatus(agentId, { state: "needs-input", note: "Asking: Needs your attention" });
        hub.activity("agent.needs-input", agentId, `${name} needs you: Needs your attention`);
      }
      break;
    }
    case "Stop": {
      // Messages that arrived while the agent was busy: hand them over now,
      // and Claude Code continues with them instead of stopping.
      const waiting = inbox.pending(agentId);
      const queued = inbox.takeForStop(agentId);
      if (queued) {
        turnOpen.set(agentId, true); // Claude continues: same turn
        hub.setStatus(agentId, { state: "working", note: "Reading new messages" });
        record(company, hub, agentId, event, { delivered: waiting });
        return { ok: true, response: { decision: "block", reason: queued } };
      }
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Finished — ready for the next instruction" });
      hub.activity("agent.answered", agentId, `${name} finished a turn`);
      break;
    }
    case "SessionEnd":
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Session ended" });
      record(company, hub, agentId, event);
      break;
    default:
      return { ok: false };
  }
  return { ok: true };
}
