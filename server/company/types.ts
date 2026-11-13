import type { AgentMode, BoardStatus, TaskStatus } from "../../src/data/types";

// Vocabulary of the company store. The SQL CHECK lists and seeds in the
// migrations are literals (a merged migration never changes); the tripwire
// test in schema.test.ts fails if a union here grows beyond its column's
// CHECK, so widening a union also needs a new migration.

export const ROLE_IDS = [
  "ceo",
  "cio",
  "security-audit",
  "cto",
  "solutions",
  "builder",
  "qa",
  "security-reviewer",
  "customer-service",
  "accountant",
  "sales",
  "marketing",
  "research",
] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export const DEPARTMENT_IDS = [
  "executive",
  "internal-it",
  "delivery",
  "clients",
  "finance",
  "growth",
  "strategy",
  "security-audit",
] as const;
export type DepartmentId = (typeof DEPARTMENT_IDS)[number];

export const HUMAN_ROLES = ["owner", "supervisor"] as const;
export type HumanRole = (typeof HUMAN_ROLES)[number];

export const AGENT_STATUSES = ["active", "paused", "retired"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

// Spec M1.2 categories; null means voluntary escalation.
export const DECISION_CATEGORIES = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

export const URGENCIES = ["critical", "high", "normal", "fyi"] as const;
export type Urgency = (typeof URGENCIES)[number];

export const DECISION_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const EXECUTION_STATUSES = ["not-started", "started", "done", "failed"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const VERIFICATIONS = ["pin", "channel-reply"] as const;
export type Verification = (typeof VERIFICATIONS)[number];

export const PERMISSION_KINDS = ["network-allow", "network-deny", "mcp-server", "secret-name", "tool", "skill"] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export const SPEND_SOURCES = ["api-metered", "subscription", "invoice", "estimate"] as const;
export type SpendSource = (typeof SPEND_SOURCES)[number];

export const ACTOR_KINDS = ["agent", "human", "hq"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

// Migration 006 (project state in the store). The compile-time checks below keep
// these lists equal to the dashboard's types, so the tripwire covers them too.
export const AGENT_MODES = ["sandbox", "local"] as const;
export const BOARD_STATUSES = ["active", "planned", "done"] as const;
export const TASK_STATUSES = ["todo", "in-progress", "in-review", "done", "blocked"] as const;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const _sameModes: Same<(typeof AGENT_MODES)[number], AgentMode> = true;
export const _sameBoardStatuses: Same<(typeof BOARD_STATUSES)[number], BoardStatus> = true;
export const _sameTaskStatuses: Same<(typeof TASK_STATUSES)[number], TaskStatus> = true;
