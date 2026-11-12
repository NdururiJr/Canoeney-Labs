// What each role may do through the Team MCP (spec §2a, M0.14; ADR 0005), and
// how a tool call's arguments are recorded in the audit trail.
import type { RoleId } from "./types";

export const HQ_TOOLS = [
  "list_workers",
  "get_status",
  "list_tasks",
  "create_board",
  "create_task",
  "update_task",
  "assign_task",
  "get_my_task",
  "set_my_status",
  "ask_user",
  "request_access",
  "send_message",
] as const;
export type HqTool = (typeof HQ_TOOLS)[number];

export const isHqTool = (name: unknown): name is HqTool => typeof name === "string" && (HQ_TOOLS as readonly string[]).includes(name);

/**
 * §2a, for the tools that exist today. "Anything not listed is not available
 * to the role." Tools §2a names that do not exist yet arrive in M1.
 */
export const TOOLS_BY_ROLE: Record<RoleId, readonly HqTool[]> = {
  cto: [
    "list_workers",
    "get_status",
    "list_tasks",
    "create_board",
    "create_task",
    "update_task",
    "assign_task",
    "send_message",
    "set_my_status",
    // Transitional (ADR 0005): §2a's M1 row replaces these with raise_decision.
    // Removing them before it exists would leave the CTO no way to reach the
    // owner. The overview carries their removal to the M1 plan.
    "ask_user",
    "request_access",
  ],
  builder: ["get_my_task", "set_my_status", "send_message", "request_access", "ask_user"],
  ceo: [],
  cio: [],
  "security-audit": [],
  solutions: [],
  qa: [],
  "security-reviewer": [],
  "customer-service": [],
  accountant: [],
  sales: [],
  marketing: [],
  research: [],
};

export const roleHas = (role: RoleId, tool: string): boolean => (TOOLS_BY_ROLE[role] as readonly string[]).includes(tool);

/** Whom a role may message (§2a). */
export const MESSAGE_TO: Partial<Record<RoleId, readonly RoleId[]>> = { cto: ["ceo", "builder"], builder: ["cto", "builder"] };

/** Argument keys that hold an id (a task, board or agent). */
const ID_KEYS = new Set(["taskId", "boardId", "agent", "owner", "to"]);
const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** String arguments recorded as they are because their schema allows only a fixed set of values. */
const ENUM_KEYS: Record<string, readonly string[]> = { status: ["todo", "in-progress", "in-review", "done", "blocked"] };

/**
 * Arguments as the audit trail records them, by allow-list, so a row stays
 * small whatever an agent sends: numbers, booleans and enum values as they
 * are; a short id under an id key as it is; every other string as its length;
 * arrays as their length.
 */
export function recordArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = (ENUM_KEYS[k]?.includes(v) || (ID_KEYS.has(k) && SHORT_ID.test(v))) ? v : { chars: v.length };
    else if (Array.isArray(v)) out[k] = { items: v.length };
    else out[k] = { type: v === null ? "null" : typeof v };
  }
  return out;
}

/** The call's target: the first id argument that is a short id, or null. */
export function targetOf(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  for (const k of ["taskId", "agent", "to", "boardId", "owner"]) {
    const v = (args as Record<string, unknown>)[k];
    if (typeof v === "string" && SHORT_ID.test(v)) return v;
  }
  return null;
}
