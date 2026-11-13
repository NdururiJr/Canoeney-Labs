// The HQ Team MCP. Agents connect over Streamable HTTP (stateless) at /mcp,
// identified by their own secret (server/agentAuth.ts). What an agent may call
// comes from its role in the company store (spec §2a; ADR 0005), read on every
// request, and every call writes one audit row before it acts.

import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Hub } from "./hub";
import { requestAccess } from "./access";
import type { Company } from "./company";
import type { RegisteredAgent } from "./company/agents";
import { isHqTool, MESSAGE_TO, recordArgs, roleHas, targetOf, type HqTool } from "./company/roleTools";
import type { Planner } from "./planner";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): Result => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fail = (msg: string): Result => ({ content: [{ type: "text", text: msg }], isError: true });

export const COULD_NOT_RECORD = "HQ could not record this action, so it was not done.";
const NOT_YOURS = "That tool is not available to your role.";

function buildServer(hub: Hub, planner: Planner, company: Company, agent: RegisteredAgent): { server: McpServer; schemas: Map<string, Record<string, unknown>> } {
  const server = new McpServer({ name: "hq", version: "0.1.0" });
  const schemas = new Map<string, Record<string, unknown>>();
  const me = agent.agentId;
  const ctoId = planner.ctoId();
  const record = (target: string | null, data: Record<string, unknown>) =>
    company.audit.append({ actorKind: "agent", actorId: agent.companyId, action: "tool.called", target, data });

  /**
   * Runs a tool body with its audit row (SR-B-12, SR-B-16): the row is written
   * first, in the same transaction, so a call whose row cannot be written does
   * not happen. A body that throws is rolled back and recorded as an error.
   */
  const audited =
    <A>(tool: HqTool, fn: (args: A) => Result) =>
    async (args: A): Promise<Result> => {
      const recorded = recordArgs(args);
      const target = targetOf(args);
      let written = false;
      try {
        return company.db.transaction(() => {
          // Re-read on every call: an agent paused or retired after its request was
          // authenticated gets nothing done (M0-B carry-forward).
          const status = company.agents.getById(agent.companyId)?.status ?? "retired";
          if (status !== "active") {
            record(target, { tool, outcome: "refused", reason: status });
            written = true;
            return fail(`You are ${status}, so HQ refused this call. Wait for the owner.`);
          }
          record(target, { tool, outcome: "ok", args: recorded });
          written = true;
          return fn(args);
        }, "immediate");
      } catch (err) {
        if (!written) {
          // The full row could not be written (e.g. an argument looks like a
          // credential): refuse, and record that a call was refused.
          try {
            record(null, { tool, outcome: "refused", reason: "unrecordable" });
          } catch {
            /* nothing more can be recorded */
          }
          return fail(COULD_NOT_RECORD);
        }
        const msg = err instanceof Error ? err.message : String(err);
        try {
          record(target, { tool, outcome: "error", args: recorded, error: { chars: msg.length } });
        } catch {
          return fail(COULD_NOT_RECORD);
        }
        return fail(msg);
      }
    };

  /** Registers a tool only when the agent's role has it. */
  const tool = <A>(name: HqTool, config: ToolConfig, fn: (args: A) => Result) => {
    if (!roleHas(agent.role, name)) return;
    if (config.inputSchema) schemas.set(name, config.inputSchema);
    const run = audited(name, fn);
    // A tool without an input schema is called with the SDK's request context
    // first; that is not the agent's arguments.
    server.registerTool(name, config as never, (config.inputSchema ? (args: A) => run(args) : () => run({} as A)) as never);
  };
  /** A tool body: throws for a failure the agent can read. */
  const body = <A>(fn: (args: A) => Result) => fn;
  const taskView = (id: string) => {
    const t = planner.task(id);
    return t && { ...t, owner: t.ownerId ? hub.name(t.ownerId) : null };
  };

  tool(
    "list_workers",
    { description: "The team: each agent's id, name, role, whether they are running, and what they are doing now." },
    body(() =>
      ok(
        hub.snap.config.team.map((a) => {
          const st = hub.status(a.id);
          return {
            id: a.id, name: a.name, role: a.role, lead: a.id === ctoId, you: a.id === me,
            running: st?.session.state === "running", state: st?.state, task: st?.currentTaskId ?? null,
            free: st?.session.state === "running" && a.id !== ctoId && !planner.currentTask(a.id),
          };
        }),
      ),
    ),
  );

  tool(
    "get_status",
    { description: "Live status of every agent (state, note, current task) plus the active boards with task counts." },
    body(() =>
      ok({
        agents: hub.snap.agents.map((s) => ({ id: s.agentId, name: hub.name(s.agentId), state: s.state, note: s.note, task: s.currentTaskId, session: s.session.state })),
        boards: hub.snap.boards.map((b) => {
          const ts = hub.snap.tasks.filter((t) => t.boardId === b.id);
          const n = (st: string) => ts.filter((t) => t.status === st).length;
          return { id: b.id, title: b.title, status: b.status, todo: n("todo"), inProgress: n("in-progress"), inReview: n("in-review"), blocked: n("blocked"), done: n("done") };
        }),
      }),
    ),
  );

  tool(
    "list_tasks",
    {
      description: "Tasks, optionally filtered by board, status or owner.",
      inputSchema: {
        boardId: z.string().optional().describe("Board id, e.g. P3"),
        status: z.enum(["todo", "in-progress", "in-review", "done", "blocked"]).optional(),
        owner: z.string().optional().describe("Agent id or name"),
      },
    },
    body(({ boardId, status, owner }: { boardId?: string; status?: string; owner?: string }) => {
      const ownerId = owner ? planner.agentId(owner) : undefined;
      const list = hub.snap.tasks.filter((t) => (!boardId || t.boardId === boardId) && (!status || t.status === status) && (!owner || t.ownerId === ownerId));
      return ok(list.map((t) => ({ id: t.id, board: t.boardId, title: t.title, status: t.status, owner: t.ownerId ? hub.name(t.ownerId) : null, needs: t.needs })));
    }),
  );

  tool(
    "create_board",
    { description: "Lead only. Create a board (a phase or an area of work).", inputSchema: { title: z.string(), active: z.boolean().optional().describe("Agents only pick tasks from active boards") } },
    body(({ title, active }: { title: string; active?: boolean }) => {
      return ok(planner.createBoard(title, active ? "active" : "planned"));
    }),
  );

  tool(
    "create_task",
    {
      description: "Lead only. Add a task. Keep tasks small: one task = one branch = one PR.",
      inputSchema: {
        title: z.string(),
        boardId: z.string().optional().describe("Defaults to the first active board"),
        description: z.string().optional().describe("What to build and why"),
        files: z.array(z.string()).optional().describe("The only files/folders this task may edit"),
        doneWhen: z.string().optional().describe("Acceptance criteria"),
        needs: z.array(z.string()).optional().describe("Task ids that must be done first"),
      },
    },
    body((args: { title: string; boardId?: string; description?: string; files?: string[]; doneWhen?: string; needs?: string[] }) => {
      return ok(planner.createTask(args, me));
    }),
  );

  tool(
    "update_task",
    {
      description: "Lead only. Edit a task's details or status.",
      inputSchema: {
        taskId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        files: z.array(z.string()).optional(),
        doneWhen: z.string().optional(),
        needs: z.array(z.string()).optional(),
        status: z.enum(["todo", "in-progress", "in-review", "done", "blocked"]).optional(),
      },
    },
    body(({ taskId, ...patch }: { taskId: string; title?: string; description?: string; files?: string[]; doneWhen?: string; needs?: string[]; status?: "todo" | "in-progress" | "in-review" | "done" | "blocked" }) => {
      return ok(planner.updateTask(taskId, patch));
    }),
  );

  tool(
    "assign_task",
    {
      description: "Lead only. Give a task to an agent. HQ tells them to pull main and start it (right away if idle, otherwise when their current turn ends).",
      inputSchema: { taskId: z.string(), agent: z.string().describe("Agent id or name") },
    },
    body(({ taskId, agent }: { taskId: string; agent: string }) => {
      const t = planner.assign(taskId, agent, me);
      return ok(`Assigned ${t.id} to ${hub.name(t.ownerId)}. They have been told to start.`);
    }),
  );

  tool(
    "get_my_task",
    { description: "Your current task: title, description, the files you may edit, done-when, and what it needs. Marks it in progress." },
    body(() => {
      const t = planner.currentTask(me);
      if (!t) return ok("You have no task right now. Wait for the lead, or ask with send_message.");
      if (t.status === "todo") planner.setStatus(me, "in-progress");
      const blockedBy = t.needs.filter((n) => planner.task(n)?.status !== "done");
      return ok({ ...taskView(t.id), waitingOn: blockedBy, rules: "Work only on this task, on its own branch. Edit only the listed files. Title the PR `[" + t.id + "] " + t.title + "`. When the PR is open, call set_my_status with in-review and the PR number." });
    }),
  );

  tool(
    "set_my_status",
    {
      description: "Update your current task: in-progress, blocked (say why), in-review (PR opened), or done. The lead is told automatically.",
      inputSchema: {
        status: z.enum(["in-progress", "blocked", "in-review", "done"]),
        note: z.string().optional().describe("Why you are blocked, or a short summary"),
        prNumber: z.number().int().optional(),
      },
    },
    body(({ status, note, prNumber }: { status: "in-progress" | "blocked" | "in-review" | "done"; note?: string; prNumber?: number }) => {
      const t = planner.setStatus(me, status, note, prNumber);
      return ok(`${t.id} is now ${t.status}.`);
    }),
  );

  tool(
    "ask_user",
    {
      description:
        "Ask the user to do something you can't do from your sandbox: create an account, database or API key, change a setting in a dashboard (Vercel, Supabase…), or put a value in your env file. It goes to their Action items list. Give a short title and clear steps. Never include secret values; name the variable instead. HQ messages you when they've done it. For a variable you need, write: add NAME to <your name>'s App variables in HQ (Settings → Sandbox → App variables), then restart <your name>. For a site you need, use request_access instead.",
      inputSchema: {
        title: z.string().describe("What to do, in a few words"),
        details: z.string().describe("The exact steps: where to go, what to create, which variable name, where to put it, and whether you need a restart. No secret values."),
        waiting: z.boolean().optional().describe("True if you can't continue without it"),
      },
    },
    body(({ title, details, waiting }: { title: string; details: string; waiting?: boolean }) => {
      if (!planner.actions) throw new Error("Action items aren't available.");
      if (!details.trim()) throw new Error("Add the steps in details, so the user knows exactly what to do.");
      const item = planner.actions.add(me, title, details, !!waiting);
      return ok(`Added to the user's Action items (${item.id}). ${waiting ? "Wait for HQ's message, or work on something else meanwhile." : "Keep working; HQ will message you when it's done."}`);
    }),
  );

  tool(
    "request_access",
    {
      description:
        "Your sandbox blocks most websites and APIs. When a request you need is blocked (docs or an API), ask the user to allow that domain. Pass the host (e.g. docs.example.com) and why you need it. The user answers in HQ; you'll get a message.",
      inputSchema: { domain: z.string(), reason: z.string() },
    },
    body(({ domain, reason }: { domain: string; reason: string }) => ok(requestAccess(hub, me, domain, reason))),
  );

  tool(
    "send_message",
    {
      description: "Send a message to another agent (id, name, or \"lead\"). HQ delivers it: right away if they are idle, otherwise when their current turn ends.",
      inputSchema: { to: z.string(), text: z.string() },
    },
    body(({ to, text }: { to: string; text: string }) => {
      const toId = planner.agentId(to);
      if (toId === me) throw new Error("That's you.");
      const toRole = toId ? company.agents.get(agent.projectSlug, toId)?.role : undefined;
      if (toId && (!toRole || !MESSAGE_TO[agent.role]?.includes(toRole))) throw new Error(`You can't message ${hub.name(toId)}.`);
      planner.message(me, to, text);
      return ok(`Sent to ${hub.name(toId)}.`);
    }),
  );

  return { server, schemas };
}

type ToolConfig = { description: string; inputSchema?: Record<string, unknown> };

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { name?: unknown; arguments?: unknown } };

/** The most messages HQ takes in one request (the MCP SDK's own batch limit). */
const MAX_BATCH = 100;

/**
 * Refuses, before the MCP SDK sees it, a tools/call (alone or in a batch) for
 * a tool outside the agent's role (SR-B-13). Returns true when it answered.
 */
function refuseOutsideRole(company: Company, agent: RegisteredAgent, res: ServerResponse, body: unknown): boolean {
  const deny = (target: string | null, data: Record<string, unknown>) => {
    try {
      company.audit.append({ actorKind: "agent", actorId: agent.companyId, action: "tool.denied", target, data });
    } catch {
      /* still refused */
    }
  };
  // Checked before anything is audited: one request is one row, whatever it holds.
  if (Array.isArray(body) && body.length > MAX_BATCH) {
    deny("unknown", { count: body.length, reason: "batch-too-large" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `At most ${MAX_BATCH} messages per request.` } }));
    return true;
  }
  const messages = (Array.isArray(body) ? body : [body]) as RpcMessage[];
  const denied = messages.filter((m) => m?.method === "tools/call" && !roleHas(agent.role, String(m.params?.name ?? "")));
  if (denied.length === 0) return false;
  // The requested names are agent text: kept only when they are HQ's tools.
  const names = [...new Set(denied.map((m) => (isHqTool(m.params?.name) ? m.params.name : "unknown")))].slice(0, 5);
  deny(names.length === 1 ? names[0] : null, { count: denied.length, tools: names });
  const error = (m: RpcMessage, message: string) => ({ jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32601, message } });
  const reply = Array.isArray(body)
    ? messages.filter((m) => m?.id !== undefined).map((m) => error(m, denied.includes(m) ? NOT_YOURS : "Not run: this batch holds a refused call."))
    : error(messages[0], NOT_YOURS);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(reply));
  return true;
}

/**
 * The MCP SDK checks a call's arguments against the tool's schema before the
 * tool runs, and answers a bad one itself. Such calls are recorded here, so
 * every call leaves a row (SR-B-16).
 */
function auditInvalidCalls(company: Company, agent: RegisteredAgent, schemas: Map<string, Record<string, unknown>>, body: unknown) {
  for (const m of (Array.isArray(body) ? body : [body]) as RpcMessage[]) {
    if (m?.method !== "tools/call") continue;
    const tool = String(m.params?.name ?? "");
    const schema = schemas.get(tool);
    const args = m.params?.arguments ?? {};
    if (!schema || z.object(schema as z.ZodRawShape).safeParse(args).success) continue;
    const row = (target: string | null, data: Record<string, unknown>) =>
      company.audit.append({ actorKind: "agent", actorId: agent.companyId, action: "tool.called", target, data });
    // Only the schema's keys are recorded (as recordArgs does); any other key is
    // agent text of any length and number, so it is only counted.
    const given = typeof args === "object" && args !== null && !Array.isArray(args) ? Object.keys(args) : [];
    const known = Object.fromEntries(given.filter((k) => Object.hasOwn(schema, k)).map((k) => [k, (args as Record<string, unknown>)[k]]));
    const otherKeys = given.length - Object.keys(known).length;
    try {
      row(targetOf(known), { tool, outcome: "invalid", args: recordArgs(known), ...(otherKeys ? { otherKeys } : {}) });
    } catch {
      try {
        row(null, { tool, outcome: "invalid", reason: "unrecordable" });
      } catch {
        /* the SDK refuses the call anyway */
      }
    }
  }
}

/** Handles one MCP HTTP request for an already-authenticated agent. The role is read from the store now, not cached. */
export async function handleMcp(hub: Hub, planner: Planner, company: Company, who: RegisteredAgent, req: IncomingMessage, res: ServerResponse, body: unknown) {
  const agent = company.agents.getById(who.companyId) ?? who;
  if (refuseOutsideRole(company, agent, res, body)) return;
  const { server, schemas } = buildServer(hub, planner, company, agent);
  auditInvalidCalls(company, agent, schemas, body);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
