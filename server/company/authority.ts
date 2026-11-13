// Who may change a project's configuration, and which changes relax a control
// (spec M0.11, §9 item 2; threat model SR-D-03). The dashboard's PIN rules and
// ProjectSettings both use relaxes(), so the two cannot drift apart.
import type { AgentMode, WorkflowConfig } from "../../src/data/types";
import { canonicalJson } from "./canonicalJson";
import type { PermissionKind } from "./types";

/**
 * - `pin`: the owner, confirmed with the approval PIN.
 * - `decision`: an approved decision (M1.4 creates them).
 * - `session`: the logged-in owner, without the PIN.
 * - `hq`: HQ itself, which may only revoke.
 */
export type Authority =
  | { via: "pin"; humanId: string }
  | { via: "decision"; decisionId: string }
  | { via: "session"; humanId: string }
  | { via: "hq" };

export type ProjectField = "name" | "officeName" | "exportPlan" | "github" | "stack";
export type AgentField = "name" | "displayRole" | "color" | "model" | "mode" | "cli" | "workspacePath" | "roleMd" | "resources";

export type ConfigChange =
  | { kind: "grant" | "revoke"; permission: PermissionKind; value: string }
  | { kind: "workflow"; before: WorkflowConfig; after: WorkflowConfig }
  | { kind: "project"; field: ProjectField; before: unknown; after: unknown }
  | { kind: "agent"; field: AgentField; before: unknown; after: unknown }
  | { kind: "agent-added" | "agent-retired" | "import" | "notes-approved" };

export type AuthorityRefusal = "pin-or-decision-required" | "not-owner" | "decision-not-approved" | "hq-cannot-grant";

export class AuthorityError extends Error {
  constructor(
    readonly reason: AuthorityRefusal,
    readonly change: ConfigChange,
  ) {
    super(MESSAGES[reason]);
    this.name = "AuthorityError";
  }
}

const MESSAGES: Record<AuthorityRefusal, string> = {
  "pin-or-decision-required": "This change relaxes a control: confirm it with your PIN.",
  "not-owner": "Only the owner can change the project's settings.",
  "decision-not-approved": "That decision is not approved.",
  "hq-cannot-grant": "HQ can take a permission away, never give one.",
};

/** Grants that widen what an agent can reach or run. A network deny tightens. */
const RELAXING_GRANTS: ReadonlySet<PermissionKind> = new Set(["network-allow", "mcp-server", "secret-name", "tool", "skill"]);

const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

function workflowRelaxes(b: WorkflowConfig, a: WorkflowConfig): boolean {
  if (b.review.enabled && !a.review.enabled) return true;
  if (b.review.tool !== a.review.tool || b.review.command !== a.review.command) return true;
  if (b.merge.by !== "lead" && a.merge.by === "lead") return true;
  // Any deploy change except turning it off.
  // Turning deploy off is tightening only when nothing else in deploy changes with it: a new
  // command or tool would run, unconfirmed, the next time deploy is turned on.
  const turnedOffOnly = b.deploy.enabled && !a.deploy.enabled && same({ ...b.deploy, enabled: false }, a.deploy);
  if (!same(b.deploy, a.deploy) && !turnedOffOnly) return true;
  return false;
}

/** True when the change needs the owner's PIN or an approved decision (the plan's values table). */
export function relaxes(c: ConfigChange): boolean {
  switch (c.kind) {
    case "grant":
      return RELAXING_GRANTS.has(c.permission);
    case "revoke":
      return c.permission === "network-deny";
    case "workflow":
      return workflowRelaxes(c.before, c.after);
    case "project":
      return (c.field === "github" || c.field === "stack") && !same(c.before, c.after);
    case "agent":
      if (same(c.before, c.after)) return false;
      if (c.field === "mode") return (c.after as AgentMode) === "local";
      if (c.field === "cli" || c.field === "roleMd") return true;
      if (c.field === "workspacePath") return typeof c.after === "string" && c.after !== "";
      return false;
    case "agent-added":
    case "import":
    case "notes-approved":
      return true;
    case "agent-retired":
      return false;
  }
}

/** HQ itself may only take permissions away. */
export const hqMay = (c: ConfigChange): boolean => c.kind === "revoke";
