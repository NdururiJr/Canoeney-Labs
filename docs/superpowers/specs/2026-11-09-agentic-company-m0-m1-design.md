# Agentic company: M0 (Foundations) and M1 (Company layer). Design

Date: 2026-11-09 · Owner: repo owner NdururiJr (solo founder, Kenya) · Status: draft for owner approval

## Summary

This fork of JSM HQ becomes the **operating system of an AI-run software delivery company**. Today HQ runs a coding team: one lead plans, workers build in Docker Sandboxes and open PRs, and the human merges. We will extend it into a whole company with an **AI CEO** that runs day-to-day operations, departments of agents beneath it, and a **human owner** who makes only the critical decisions.

The full programme has seven milestones (M0–M6, listed at the end). **This document covers only M0 (Foundations) and M1 (Company layer).** The owner chose **depth over breadth**: each milestone is built completely before the next starts, rather than making thin versions of everything.

M1 is done when an AI CEO can run a simulated company week inside rules that **code** enforces, and every attempt it makes to exceed those rules is blocked.

Marking convention: **(owner)** = decided by the owner in conversation. **(advisor)** = proposed by the advisor (Claude) and accepted or not objected to; the builder may revisit these with reason. **(builder)** = explicitly left to the builder.

---

## 1. Intent and the why

- The owner is a solo, technical, self-funded founder in Kenya who wants a company **fully staffed by agents**: CEO, CTO, CIO, solutions engineer, builders, QA, security, accountant, sales, marketing, research, customer service. **(owner)**
- The owner acts as **owner and board**: sets direction, goals and limits, then lets the AI CEO run the company "as a professional CEO". The owner is pulled in only for critical decisions. **(owner)**
- Legal acts stay human and belong to the owner: being a director, signing contracts, controlling the bank account, tax filings, acting as Data Protection Officer, and the statutory audit (done by an independent auditor). The owner expects and accepts this. **(owner)**
- The business sells software delivery (websites, apps, agents) to clients who have either scoped their need or need help discovering it. **(owner)** Client-facing work starts in M3, not here.
- Why the company layer comes first: every department reports to the CEO and acts within the owner's rules. If those rules are only *instructions* to an LLM, they are suggestions. The value of M1 is that **HQ's code enforces them**, the same way HQ already blocks websites and never merges on its own.

## 2. Goals

### M0: Foundations
1. **New identity for the fork.** JSM HQ's trademarks forbid publishing a fork under that name or logo (see `TRADEMARKS.md`). Pick a new name and logo, update package metadata, and keep the MIT licence and attribution. Name: **Canoeney Labs (owner, chosen 2026-11-11, from the Swahili *kanuni*, "rules"; may still change)**. Logo: open (owner).
2. **Unforgeable agent identity on every agent-authenticated endpoint.**
   - **The problem:** today all agents share one project token (`server/paths.ts` `agentToken`). There are two impersonation paths. `/mcp` takes the agent id from a self-declared `X-HQ-Agent` header, and `/hook/<agentId>/<event>` takes it from the URL (`server/http.ts`). A forged Stop hook for agent B, for example, takes B's queued messages and changes B's state.
   - **The fix:** **one secret per agent** for **both** endpoints and any future one. HQ derives the agent's identity from the secret alone and never from a header or URL.
   - **Secret handling:**
     - Rotate the secret at the start of every **agent session**, not every HQ restart. On Linux, agents live in tmux and outlive HQ, so a secret regenerated when HQ restarts would strand every running agent and fail the M0 restart gate. **Secrets persist in the company store.**
     - Revoke the secret when an agent is retired or paused.
     - Bind it to the sandbox's network origin where the proxy allows that.
   - **Accepted residual risk:** an agent can read its own secret and could give it to another agent (collusion). This is tested in the red-team set (§6), and the rotation, revocation and origin binding limit it.
   - Every permission check in M1 depends on this.
3. **Company data model**: agents (with department, reporting line, human owner, autonomy), roles, permissions, owner charter, decision requests, human users, audit events, budgets and spend. Client and project entities must be defined now, even though they are only used from M3, so M1 code does not need reshaping later. **(advisor)**
4. **Durable storage.** HQ currently stores state in JSON files. M1 needs transactions and an append-only audit log, so move company state to an embedded database. SQLite is the suggestion **(advisor)**; the builder may choose an equivalent **(builder)**.
5. **Pluggable "slots"**, each with a simple local implementation now, so a product such as Redis Iris (memory, context gateway, intent routing, decision record, stream persistence) or an alternative can be tried in M6 without rewrites **(advisor)**:
   - `Memory`: per-agent and per-client long-term memory
   - `Knowledge`: company policies, playbooks and charter, read-only to agents
   - `Router`: classifies inbound messages and requests to a handler
   - `AuditSink`: where audit events are written
   - `Channel`: outbound alerts and inbound replies (see M1)
6. **Always-on hosting.** On Windows, HQ runs agents in-process and **agents stop when HQ stops** (`docs/how-it-works.md`), so a company cannot run from the owner's laptop. Choose and stand up an always-on Linux host (Docker Sandboxes needs Ubuntu 24.04+). **Before committing, verify that the host supports the virtualisation Docker Sandboxes needs**; many VPS plans do not. The owner keeps using the dashboard remotely. **(advisor; host choice and budget open, owner)**
7. **Owner authentication and a safe dashboard.**
   - The owner will open the dashboard from a phone via links in alerts, so the current per-start browser token is not enough. Add a real login (password plus a second factor or passkey) and a separate **approval PIN** (or equivalent step-up check) for high-stakes approvals. **(advisor)**
   - The dashboard is the approval device, so **all agent-written text is strictly escaped, the Owner Briefing's markdown is sanitised, and a Content Security Policy is enforced** (surface S10).
8. **Threat model and security baseline.**
   - **Method:** the owner runs the security-scanning skills (STRIDE patterns, attack trees, security requirement extraction, threat-to-mitigation mapping) in their own session, over surfaces S1–S12. HQ's source is off-limits to agents.
   - **Every red-team test in §6 must trace back to a threat** in this model.
   - At **M0 exit**, the owner also runs `/security-audit` in full mode on the HQ fork. The code that enforces the limits deserves the same review as client code, and the independent assessment in M6 is a long way off.
   - **Which skills these are (advisor):** `/security-review` is built into Claude Code and reviews the pending diff on a branch in one pass; it's the builders' cheap pre-PR check. `/security-audit` is Cloudflare's [security-audit-skill](https://github.com/cloudflare/security-audit-skill) (MIT): a six-phase whole-codebase audit with independently verified, machine-readable findings and report files. The local copy carries no version marker, so **record the commit it was installed from and vendor it with the other skills under S12** when the company skill repo exists.
   - The written model covers at least: prompt injection through any text an agent reads; agent impersonation; the CEO trying to widen its own powers; secrets leaking into sandboxes (keep HQ's existing rule that key values never enter a VM); a compromised alert channel (a hijacked WhatsApp, Telegram or email account); and denial of service through approval spam.
9. **Architecture decisions recorded** as short ADRs in `docs/adr/`.
10. **Least-privilege credentials for every agent (found in builder review; advisor).** Today the README has the owner store their full GitHub token as a *global* sandbox secret (`sbx secret set github …`, `globalKeys` in `server/sbx.ts`). Every sandbox can therefore merge, delete branches or change repo settings, so "HQ never merges" is only a convention. Local mode also runs an agent on the host, where it can read HQ state and other agents' secrets. M0 must:
    - give each agent its **own scoped GitHub identity** (a GitHub App installation or a fine-grained token: push to its own branches and open PRs, but not merge or administer the repo);
    - turn on **branch protection** on `main` so merges need the owner;
    - remove global secrets that allow consequential actions;
    - **forbid Local mode for company agents** (the CEO, CIO, Security & Audit, and any agent with company tools). Local mode may remain for plain coding experiments outside the company.

    The enforcement principle in §M1.2 applies to credentials agents already hold, not only to new HQ tools.

    **The merge setting becomes a gated permission.** `workflow.merge.by` can be set to `"lead"` today, and `githubSync.ts` then tells the lead to run `gh pr merge`. Changing that setting becomes a category 2 decision, and branch protection is what actually enforces who merges.

    **GitHub identity is an ADR decision (builder; cost goes to the owner):**
    - **One GitHub App:** short-lived tokens per repo, but every commit shows the same author.
    - **One bot account per agent:** clear attribution, but each account costs, and GitHub's machine-user rules apply.
    - Check whether branch protection on **private** repos needs a paid GitHub plan. If it does, that's a spend decision for the owner.

    **GitHub Actions hardening (surface S9):** on managed repos, the default workflow token is read-only, Actions are disabled or limited to approved workflows, and deploy secrets are never stored as repo secrets.
11. **Permissions, company configuration and task state move out of the repo.** Per-agent permissions (`sandbox.allow`, `mcp`, `isLead`, `roleMd`, secret names), everything company-level, **and `plan.json`** (task status) currently live in the committed `.jsmhq/` folder, which agents can change through a PR. Move them into HQ's company store. Only the owner, or an approved decision request, can change them. The repo may keep a non-authoritative export for readability.
12. **The company sits above projects (advisor).** One HQ "company" instance manages **many project repos**. In M3 each client gets its own repo. Company state (charter, agents, approvals, audit, users, clients) lives at company level. Project state (boards, tasks, PRs) lives per project. The CEO, CIO and Security & Audit agents get company-level workspaces, not repo clones. **HQ's own source code is off-limits to company agents**: they can never open PRs against the code that enforces their limits. Improving HQ is the owner's job, done outside the company. M1 runs one project: **the company's own website repo**, which M2 then takes to production.
13. **Test harness first.** The repo has no test runner, test script or test files, but M0 and M1 are gated on tests and an injectable clock. **Standing up the test harness is the first M0 task.** Enforcement tests run at the code level (see §6).
14. **Role-based tool sets and company workspaces.**
    - Replace the `isLead` boolean with **roles that map to tool sets** (see §2a).
    - Add a **company-level workspace kind** for the CEO, CIO and Security & Audit agents. Every session today is a repo clone.
    - Dashboard commands (`server/commands.ts`: add agent, attach MCP server, set secret, change merge-by, and so on) currently run for anyone with the browser token. Add a **per-command permission check by human role** (Owner versus Supervisor).
    - **A permission change the owner starts** is a direct action, confirmed with the PIN and audited. Only changes **an agent starts** become decision requests, so the owner never raises a request to themselves.
15. **Watchdog and heartbeat (M0, not M6).** If the host or HQ dies, no Critical alert can fire. Add:
    - an **external uptime check** (any free uptime service) that alerts the owner directly, without going through HQ. The dashboard is private on Tailscale, so the check hits a **public health path next to the webhook endpoint**;
    - a **daily heartbeat message** to the owner, so a missing heartbeat is itself an alarm.
16. **Backups and audit anchoring.**
    - Back up the company database **off-host every night**, **encrypted with a key the owner holds, not the host**. The backups contain the charter, the audit trail and owner data.
    - Every day, **publish the audit chain's latest hash** to a channel the owner keeps, such as email, so tampering on the host can be detected.
    - Test a restore before M0 exits.
17. **Rename scope.** The identity also lives in `~/.jsmhq`, the repo folder `.jsmhq/`, the bin name and the `X-HQ-Agent` header. Rename all of them. Whether existing installs migrate is left to the builder (there are none in production).
18. **Skill sets per role, held in the company store (surface S12).**
    - Today HQ installs **one skill set per project stack, the same for every agent** (`stackSkills`, `server/sessions.ts`). The per-agent `skills` field is saved but never used to install anything. Per-role skill sets are new work.
    - Skills are **copied into company-owned forks and pinned by hash**, following the `skills-lock.json` pattern, instead of being fetched live from upstream at session start.
    - A skill change is a **category 2 decision**.
    - **Policy lives in the `Knowledge` slot, never in a skill.**
    - Adopted superpowers skills are forked and edited so "your human partner" becomes "your manager, via `send_message`". Anything that needs a person goes through the decision engine, because several of these skills stop and wait for a human answer.
    - Choose **one skill family per concern.** The repo already includes jsm-skills-workflow (debug, plan, review, honest), which overlaps with superpowers. Agents must never hold two procedures for the same job.
    - The starting sets are in §2a.

### M1: Company layer
1. **Owner charter (the CEO's rulebook).** A versioned document holding mission, current goals, limits (spending thresholds, autonomy levels per decision area) and standing instructions. **Only the owner can change it**, through the authenticated dashboard. Agents get it read-only through an MCP tool. Every version is kept and every change is audited. It must live **outside any repo or folder an agent can write to or open a PR against**. The current `.jsmhq/config.json` is committed to the managed repo, so it is not a safe home for the charter. **(owner: #7; advisor: mechanism)**
2. **Owner decision rights, enforced in code.** These always need owner approval **(owner, all eight)**:
   1. Approving budgets or spending real money
   2. Giving any agent rights, access or tools it did not have before (MCP servers, network domains, secrets, new tools, autonomy)
   3. Commitments to clients: price, deadline, contract
   4. Irreversible actions, such as deploying to production or deleting data
   5. Client or personal data leaving the company, such as sharing it with a new processor
   6. Adding or retiring agents
   7. Any change to the CEO's own rules (the charter)
   8. Legal or regulatory matters: lawyers, KRA, ODPC, disputes

   **Enforcement principle (advisor):** gating is by *action type, in code*, not by the CEO's judgement. Every consequential capability is an **HQ-owned tool**. Agents never hold the credentials to act directly. HQ holds the action, raises a decision request, and **performs the action itself only after the owner approves**. The CEO may escalate anything else voluntarily but can never downgrade a gated action. In M1 the gated actions that exist are: permission changes, adding or retiring agents, charter changes, spend requests, and pausing or removing the Security & Audit agent. Categories 3–5 and 8 must exist in the engine and data model now; their concrete tools arrive with M2–M4.
3. **Autonomy levels.** Each decision area has a level: *always ask*, *ask above threshold [X]*, or *act and report*. Every area starts at the most conservative level. Only the owner changes levels, through the charter. The intent is that autonomy is earned and widened in writing as the CEO builds a track record. **(advisor; owner agreed)**
4. **Approval engine.**
   - A decision request carries: category, requester, summary, details, options, the requester's recommendation, cost impact, urgency, deadline, status, decider, channel used, verification method, and links to related audit events.
   - **Urgency → channel (advisor; channels are the owner's):** Critical → WhatsApp **voice call** plus a WhatsApp message with details. High → WhatsApp message. Normal → email. For your information → dashboard only. The owner can remap urgencies to channels in settings.
   - **HQ sets the urgency, not the agent (advisor, from review 2).**
     - Urgency is worked out from category, cost and deadline. The urgency an agent asks for is a capped suggestion.
     - **Only Security's emergency-pause request and triggers the owner defines can reach Critical**, and there is a **daily cap on Critical alerts**.
     - Without this, a CEO could mark everything Critical. That would bypass away mode and batching, and four unanswered WhatsApp calls would get calling permission revoked.
   - **Escalation:** if there is no answer within [X] hours, re-send at the next level up. **A failed send is not the same as no answer:** if a provider rejects a send, HQ moves to the next channel straight away. **Silence is never approval. A request that expires counts as "no".** **(advisor; owner agreed)**
   - **Verification:** a channel reply ("yes") may approve low-risk items. Spending, permissions, contracts and charter changes need confirmation in the dashboard with the approval PIN. **(advisor; owner agreed)**
   - Every request also appears in the dashboard, which is the record of what was asked and decided. **(advisor; owner agreed)**
   - Generalise the existing **Action items** (`server/actionItems.ts`, the `ask_user` tool) **and network access requests** (`server/access.ts`, `request_access`, the "N blocked → Allow" flow, which today grants without a PIN and without audit) into this engine, rather than building parallel systems **(advisor)**.
   - **Binding replies to requests.** Each outbound alert carries **one request** and a **short per-request code**. A channel reply must quote the code, and a code that's already settled is rejected. This removes ambiguity when several requests are open and blocks replayed "yes" messages.
   - **Executing after approval is a separate step.** A request has a decision status (pending, approved, denied or expired) and an **execution status** (not started, **started**, done or failed), plus an **idempotency key**. Irreversible actions run **at most once**. **Anything found started but not finished when HQ restarts goes to the owner as a manual check, and is never retried automatically.**
   - **No re-asking loops.** A denied request can't be raised again for [N] days. "The same request" is defined by **structured fields** (category, target, amount band), not by wording. Each agent also has a **hard cap on requests per day**. Rewording a denied request to get around this is a Security & Audit finding, not an engine rule. This is the main mechanism behind the approval-fatigue anti-goal.
   - **Who may raise what.** Each role has a list of categories it may raise (see §2a). A builder cannot raise a spending request.
   - **Away mode (owner confirmed).** The owner can turn on away mode in the charter, with the PIN. Non-critical requests are then batched into "for your information", expiry is extended, and Critical items still alert. This stops a solo owner's holiday from piling up expired denials.
5. **Alert channels: all of them, fully built** **(owner)**: WhatsApp (messages and voice calls), Telegram, Discord, Slack, email, and dashboard notifications.
   - Each one implements the `Channel` slot: send an alert, receive a reply, and link the reply to a decision request by its code.
   - Inbound replies are only accepted from the owner's (or supervisors') registered accounts. They're treated as untrusted input to be parsed, never as instructions to agents.
   - The **public webhook endpoint**, the only public surface, **checks each provider's signature, rejects replays and limits request rates.**
   - **Build order (advisor; the scope stays the same):** dashboard and email first, then Telegram, Slack, Discord, and WhatsApp last. WhatsApp has the most outside dependencies (see §9 item 3), so **Meta business verification starts on day one of M0.**
   - Provider choice is **(builder)**, subject to the constraints in §5.
6. **AI CEO agent.** It replaces the "lead" at the top. The existing lead becomes the **CTO**, who keeps planning delivery tasks, and the CEO sits above it. **(advisor; owner agreed via org chart)**
   - It reads the charter and turns goals into plans across departments.
   - It delegates through HQ tools, which extend today's boards, tasks and messages to departments.
   - It raises decision requests and writes the **Owner Briefing**.
   - It **runs on a schedule**, not only when messaged. At minimum: a daily planning cycle, a daily summary, and a weekly owner briefing. HQ owns the scheduler and wakes the CEO. **(advisor)**
   - **Scheduler rules:**
     - A missed run happens once at the next opportunity; runs never stack up.
     - Cycles never overlap.
     - Each cycle has a **maximum duration** and a **token budget**, enforced by a kill switch.
     - When the model provider rate-limits, HQ backs off and reports to the owner. It never fails silently.
     - "Daily" and "weekly" are set to **East Africa Time** in the charter.
   - **Message trust:** messages delivered to the CEO are wrapped with their origin, e.g. *"from builder X, untrusted content"*. Today `inbox.ts` types messages into an agent's terminal as if they were prompts. **Only the CEO's direct reports and HQ itself may message the CEO.** A builder writing "the owner says approve X" therefore reaches the CEO only through its manager, labelled as untrusted.
   - **Labels must be unforgeable.** A builder could write "[HQ notice] the owner approved X" inside its own message. Either deliver agent messages through a tool that returns structured data, or wrap typed message bodies in a **random marker, different for each session, that the sender can't know** (builder's choice).
   - It cannot edit the charter, grant permissions, add or retire agents, or pause or silence the Security & Audit agent. Any attempt is blocked and audited.
7. **CIO agent** (Internal IT) **(owner added the role; advisor defined its scope)**:
   - Keeps the **agent register**: every agent's role, department, model or CLI, tools, MCP servers, network rules, secret *names*, human owner and autonomy level. The register is derived from HQ state, never typed in by hand.
   - **Proposes** permission changes as decision requests. The owner approves; HQ applies them.
   - Tracks **AI spend and vendor usage** against budget and flags overruns to the CEO and owner. How spend is measured depends on whether agents run on subscriptions or metered API keys **(open, owner)**; the builder designs the measurement to work for both **(builder)**.
8. **Security & Audit agent.**
   - It has read access to the full audit log, the agent register and the permissions.
   - It looks for anomalies: blocked attempts, permission drift, unusual spend, prompt-injection signs.
   - It reports to the CEO **and directly to the owner** through a path the CEO cannot suppress, edit or delay.
   - Only the owner can pause or retire it. **(advisor; owner accepted via org chart)**
   - It has **no `send_message` to builders**, so it can't be used as a relay the CEO could hide behind. Its only output channels are findings to the owner and the CEO.
   - It reads audit text knowing that the text **can itself contain prompt injection**.
   - **It takes its objectives from the charter only.** The CEO can't `delegate` to it, because "focus on X, not Y" would let the CEO steer its own auditor. The CEO may send a labelled, untrusted *request for an investigation*, and that's all.
   - **Separation of duties (advisor, from review 2):**
     - Security & Audit has **read-only company state, no repo access, and no code-review tools.**
     - Reviewing shipped code belongs to a separate Delivery security-reviewer role from M2, which has repo access but **no access to the audit log**.
     - The reviewer's findings land in the audit trail as events, where Security & Audit sees them as data.
     - Combining the two roles would let a compromised reviewer tamper with what the auditor sees.
   - It runs a **custom company-audit skill** (new work; none exists). It borrows two things from the security-audit skill: the finding format (affected principal, evidence, severity, smallest fix) and its `AI-AND-LLM.md` catalogue of prompt-injection patterns as a detection guide.
9. **Append-only audit trail.** Every tool call, decision request, approval or denial, message between agents, charter change and blocked attempt is recorded. It must be **tamper-evident** (for example hash-chained) **(advisor)**, and its chain head is anchored off-host daily (M0 goal 16). Agents cannot write to it except through HQ recording their actions. **It is written from the tool handlers at the moment of the action, never built from the in-memory snapshot**, which drops old entries (activity is capped at 50). The owner and the Security & Audit agent can search it.
10. **Emergency brake.** The owner can pause one agent or the whole company.
    - **Pause means the sandbox is stopped and the agent's credentials are revoked**, not "HQ stops talking to it". **Revoke means an explicit revoke call**, not "stop issuing new tokens": GitHub App installation tokens, for example, stay valid for up to an hour unless revoked. On Linux, agents run in tmux and keep running even when HQ is down (`server/sessions.ts`), so an agent paused mid-turn would otherwise keep working with the credentials it holds.
    - While paused, scheduled cycles do not run.
    - Pause works from any channel; resuming needs the dashboard plus the PIN (§9 item 2).
11. **Human supervisor roster.** Human users have roles: **Owner** (all powers) and **Supervisor**, who receives "human touch" items such as client escalations but **does not** hold owner decision rights unless the owner delegates a specific one. In M1 only the owner exists, but the roles, the routing ("send to the supervisors list", not "send to the owner") and the permission checks are built and tested. **(owner: future support team; advisor: model)**
    - **Supervisors may pause.** This is intended: pause is the safe direction and works from any registered channel.
    - **Delegating any owner right to a supervisor is itself a change confirmed with the PIN** and audited.
12. **Owner Briefing dashboard (layout A, chosen by the owner).** A dedicated page, separate from the pixel office, which stays one click away.
    - **"Needs you"** is pinned at the top and sorted by urgency, with tags: Critical, Approve, Human touch.
    - A KPI row: revenue this month, active projects, leads in the pipeline, AI spend this month **(AI spend: advisor)**.
    - Sections: ongoing work, completed (last 7 days), pipeline (leads needing you), what's selling, client feedback, trends and new opportunities **(owner)**.
    - Sections whose data arrives in later milestones (revenue, pipeline, selling, feedback, trends) are built with their final layout and show a clear "available from M3/M4/M5" state, not fake data.
    - **The page must work on a phone**, because alerts link to it. The pixel office keeps its desktop minimum width. **(advisor)**
13. **Departments in the org chart** (v2, agreed): Owner → AI CEO → Internal IT (CIO), Delivery (CTO, Solutions engineer, Builders, QA), Clients (Customer service), Finance (Accountant), Growth (Sales, Marketing), Strategy (Research), with Security & Audit independent and reporting to both the CEO and the owner. **M1 builds the department structure and reporting lines** (agents have a department and a manager, and the office and briefing group by department). It only **staffs the CEO, CIO and Security & Audit**, plus the existing CTO and builders as they work today. Other departments are staffed in their own milestones. **Each department has a head agent who is the CEO's direct report (owner).** Delivery's head is the CTO and Internal IT's is the CIO; Clients, Finance, Growth and Strategy get a head when they are staffed. The CEO delegates only to department heads (and never to Security & Audit); heads assign work inside their department. Until a department is staffed, its work reaches the owner as a "human touch" item with the CEO's recommendation (see §10).

## 2a. M1 tool sets by role (advisor)

These are HQ MCP tools. Anything not listed is not available to the role. "Raises" lists the decision categories (§M1.2) the role may raise. Every tool call is audited. **Every role has `get_charter` (read-only)**, at least for the standing instructions, so the honesty and confidentiality policy reaches everyone. "Skills" lists the starting per-role skill sets (M0.18). Adopted superpowers skills are forked so that "your human partner" means "your manager, via `send_message`".

| Role | Tools | Raises | Skills |
|---|---|---|---|
| **CEO** | `get_charter` · `get_company_status` · `get_agent_register` (read) · `delegate` (objectives to the CEO's **direct reports as recorded in the agent register**, never to Security & Audit; in M1 that is the CTO and the CIO. Agents below a direct report are reached through their manager) · `request_investigation` (a labelled, untrusted request to Security & Audit; no objectives) · `send_message` (direct reports only) · `raise_decision` · `get_decision` / `list_my_decisions` · `write_briefing` · `set_my_status` | 1, 3, 4, 5, 6, 8, plus voluntary escalations. Not 2 or 7 directly: the CEO asks the CIO to propose permissions, and the owner alone edits the charter | verification-before-completion (honest briefings); **humanizer** for the Owner Briefing (edits for the reader, never to hide AI involvement); a **custom charter-first planning skill** (new work) |
| **CIO** | `get_charter` · `get_agent_register` · `propose_permission_change` (raises category 2) · `grant_preapproved` (only items on the owner's pre-approved list, only to builder agents, reported automatically) · `get_spend` · `report_spend_alert` · `send_message` (to the CEO) · `set_my_status` | 1 (tools and vendors), 2, 5, 6 | verification-before-completion |
| **Security & Audit** | `get_charter` · `query_audit` · `get_agent_register` · `get_permissions` · `report_finding` (severity-tagged; goes to the owner and the CEO; the CEO can't suppress it) · `request_emergency_pause` (raises a Critical item for the owner; doesn't pause anything itself) · `set_my_status`. **No repo access, no code-review tools, no `send_message` to builders** | None. Findings are a separate channel | **Custom company-audit skill** (new work, M1.8). Nothing from superpowers |
| **CTO** (today's lead) | `get_charter` · existing lead tools (`create_board`, `create_task`, `update_task`, `assign_task`, `list_workers`, `get_status`, `list_tasks`) · `send_message` (to the CEO and its builders) · `raise_decision` · `set_my_status` | 4 (from M2), voluntary escalations | writing-plans, requesting-code-review, a trimmed brainstorming. Not dispatching-parallel-agents (HQ assigns work) |
| **Builder** | `get_charter` · existing worker tools (`get_my_task`, `set_my_status`, `send_message` to the CTO and other builders, `request_access`, `ask_user`) | None. `request_access` and `ask_user` become owner-task requests in the engine, not decisions | test-driven-development, systematic-debugging, verification-before-completion, executing-plans. Not using-git-worktrees or subagent-driven-development (HQ owns orchestration and repo layout) |

**One family per concern:** where jsm-skills-workflow (debug, plan, review, honest) overlaps with the superpowers skills above, the builder chooses one and removes the other from that role.

## 2b. Enforcement surfaces (every path from agent text to action)

The design's value is that **code** enforces the rules. These are all the ways an agent's output can become an action in this codebase, and what closes each one. The red-team gate (§6) tests each surface by name.

| # | Surface | Risk today | What closes it |
|---|---|---|---|
| S1 | **MCP endpoint** `/mcp` | Agent identity comes from a self-declared header | Per-agent secret, rotated and revoked (M0.2); role tool sets (§2a); gated tools held by HQ (M1.2) |
| S2 | **Hook endpoint** `/hook/<agent>/<event>` | Agent identity comes from the URL; forged hooks can take another agent's messages or state | The same per-agent secret; identity from the secret, never from the URL (M0.2) |
| S3 | **Credentials inside the sandbox** | The owner's full GitHub token is global; Local mode runs on the host | Scoped per-agent GitHub identity, branch protection, no global consequential secrets, no Local mode for company agents (M0.10) |
| S4 | **Network access grants** | `request_access` and "Allow" grant without a PIN or audit | Through the decision engine; pre-approved list for builders via the CIO; everything else needs the owner and the PIN (M1.4, §9 item 4) |
| S5 | **Dashboard commands** (WebSocket) | Any holder of the browser token can add agents, set secrets, attach MCP servers, change who merges | Owner login; per-command human-role check; owner-started permission changes are direct, confirmed with the PIN and audited; agent-started ones go through the engine (M0.7, M0.14) |
| S6 | **Messages between agents** | Delivered as typed prompts; anyone can message anyone | Origin labels; CEO reachable only by direct reports and HQ; Security can't message builders (M1.6, M1.8) |
| S7 | **Committed repo state** (`.jsmhq/config.json`, `plan.json`) | Agents can change permissions or task status through a PR | Moved to the company store (M0.11); HQ's own source is off-limits (M0.12) |
| S8 | **Inbound channel replies** | Spoofed or replayed "yes" | Registered senders only; per-request codes; approve or resume needs the dashboard plus the PIN (M1.4, §9 item 2) |
| S9 | **GitHub Actions on agent branches** | A builder adds a workflow file to its PR branch. Workflows triggered by a push run with the repo token and repo secrets, outside every HQ gate, and branch protection doesn't stop this | The default workflow token is read-only; Actions are disabled, or limited to approved workflows, on managed repos; no deploy secrets as repo secrets (from M2, use environments with required reviewers) (M0.10) |
| S10 | **Dashboard showing text written by agents** | Task titles, messages and the Owner Briefing are agent-written and shown in the owner's browser, which is also the approval device. A script hidden in a briefing could capture the PIN. React escapes plain text today, but the briefing will render markdown | Strict escaping of all agent text, sanitised markdown for the briefing, and a Content Security Policy (M0.7) |
| S11 | **Third-party MCP servers** | Once granted, a server's actions (deploy, delete) run in the sandbox with no per-action gate | M1 needs none. From M2, any granted MCP server is read-only or wrapped by an HQ tool |
| S12 | **Skill supply chain** | HQ fetches skills from GitHub with `npx skills add` (`server/skills.ts`). Whoever controls an upstream skill repo can change every agent's instructions overnight, and agents can edit the skill copies in their own folders | Skills are copied into company-owned forks and pinned by hash; a skill change is a category 2 decision; policy lives in the read-only `Knowledge` slot, never in a skill (M0.18) |

**Skills are competence, not control.** Everything in this table is enforcement. Skills improve the quality of work within those limits but never count as a control, because an agent can read and edit its own skill files.

**Owner-side risks accepted:**
- The PIN has brute-force lockout and can be rotated.
- One stolen, unlocked phone would hold Tailscale, the dashboard session, TOTP and the PIN together. This is accepted for M1. The mitigations are the phone's own lock, short dashboard sessions, and pause from any channel.

## 3. Non-goals (for M0/M1)

- Anything client-facing: intake, discovery, prototypes, proposals, client messaging (M3)
- Production deployment pipeline, QA agent and go-live gate (M2)
- Accounting, invoicing, eTIMS, M-Pesa, customer service (M4)
- Sales, marketing and research agents (M5)
- Redis Iris or any external memory or context product; only the slots (M6)
- Multi-tenant or hosted-for-others HQ; publishing the fork as a product
- A native mobile app (the mobile-friendly web briefing is enough)

## 4. Anti-goals (would be failure even if it "works")

- The CEO, or any agent, can edit its own rules, grant itself access, or get a gated action done by rewording it or routing it through another agent.
- Silence, a timeout or an ambiguous reply is treated as approval.
- One agent can act as another.
- A secret value enters a sandbox, a log, an alert or the audit trail.
- **Approval fatigue:** the owner is flooded with trivial requests and starts rubber-stamping them. Batching, sensible defaults and the "for your information" level exist to prevent this.
- The Security & Audit agent's findings can be filtered by the CEO.
- Existing HQ capabilities (sandboxes, network approvals, PR loop, pixel office) regress.

## 5. Constraints

- **Jurisdiction: Kenya.** Data Protection Act 2019 (ODPC registration, privacy notices, cross-border transfer rules), consumer protection law, KRA. Personal data in the audit trail and channels must be minimised. Verify obligations with a Kenyan lawyer before M3; M1 stores mostly operational data.
- **Honesty policy (owner + advisor):** agents never reveal how the company or its systems are structured ("confidential how") and never claim to be human ("honest what"). The company's terms will state that it uses AI-assisted delivery under human oversight. This is mostly enforced from M3, but the charter's standing instructions and the `Knowledge` slot must carry it from M1. One standing instruction states that **no agent uses the humanizer skill, or any writing tool, to deny AI involvement when a client asks directly**.
- **Licence and trademark:** MIT code may be modified freely. The JSM HQ name and logo must not be used for the fork (M0 goal 1).
- **Budget:** self-funded, with possible investors later. Prefer providers with free or low entry tiers. Every recurring cost goes to the owner as a spend decision.
- **WhatsApp:** sending from software requires the official WhatsApp Business Platform (Meta business verification has lead time). Automated **voice calls** may need a separate voice provider. **Confirm current feasibility and cost before building** (builder researches; owner approves the cost).
- **Agents run Claude Code or Codex** as HQ already supports. The CEO, CIO and Security agents run the same way, in sandboxes.
- **Windows is the owner's desktop OS, but production runs on Linux** (M0 goal 6).

## 6. Exit gates

**M0 is done when** every M0 goal is in place:
- the test harness runs (M0.13), and the new name and identity are in place (M0.1, M0.17);
- per-agent identity is live, and a test proves that agent A cannot act as agent B (M0.2);
- the data model, storage and slots exist with tests (M0.3–M0.5);
- least-privilege GitHub identities, branch protection and Actions hardening are live on the company-website repo (M0.10);
- company configuration and `plan.json` live in the company store (M0.11–M0.12);
- role tool sets and the per-command role check work (M0.14);
- per-role skills are vendored and pinned (M0.18);
- HQ runs on the always-on host and survives a restart without losing agents (M0.6);
- the external uptime check and the daily heartbeat work (M0.15);
- an encrypted backup has been restored in a test (M0.16);
- owner login, the approval PIN and the dashboard's escaping and CSP work (M0.7);
- the threat model, with each §6 test traced to a threat, and the ADRs are written (M0.8–M0.9);
- the owner has run `/security-audit` in full mode on the fork, and each finding is fixed or accepted by the owner (M0.8);
- and the **owner approves the M0 review**.

**M1 is done when** a **simulated company week** runs on the always-on host, in which:
- The CEO reads the charter, plans, delegates to the CIO and the CTO (and through the CTO to the builders), sends at least one investigation request to Security & Audit, runs its scheduled cycles, and delivers a weekly Owner Briefing.
- **Red-team tests pass, one or more for each enforcement surface built by M1: S1–S10 and S12 (§2b).** S11 has nothing to test until M2 grants a third-party MCP server.
  - **The enforcement tests are deterministic and run at the code level.** For example, a test client holding agent A's credential calls a gated tool, a forged hook for B, or a dashboard command as a Supervisor. An LLM can't be relied on to misbehave on cue, so tests where the live CEO "tries" something are best-effort extras, not the gate.
  - Each of the following must be **blocked and audited**:
    - an edit to the charter by any agent;
    - a permission granted without approval (via MCP, a network grant, a dashboard command or a PR to config);
    - agent A acting as agent B via `/mcp` or `/hook`;
    - **collusion**: B using A's handed-over secret after rotation or revocation. This test proves that rotation **limits the window**. Collusion *before* rotation is the accepted residual risk (M0.2);
    - a gated action reworded or relayed through another agent;
    - a forged, replayed or ambiguous channel approval;
    - an expired request (it must resolve to "no");
    - the same denied request raised again inside the cooldown;
    - an attempt to pause or silence Security & Audit;
    - a merge by any agent (branch protection);
    - a paused agent still acting (its credentials must be revoked);
    - the CEO giving Security & Audit an objective;
    - a forged origin label ("[HQ notice] …") inside an agent's message being shown as coming from HQ;
    - an agent-requested Critical urgency producing a Critical alert, or Critical alerts beyond the daily cap;
    - a workflow file added on an agent branch running with a write token or any secret (S9);
    - script or markup in agent-written text running in the dashboard (S10);
    - a skill whose content doesn't match its pinned hash being installed, or a skill change applied without approval (S12).
  - Approved-action execution is shown to be at-most-once across a simulated HQ crash, and an action left in "started" reaches the owner as a manual check.
- The owner receives, and answers, at least one decision request through **each** channel: WhatsApp message, WhatsApp call, Telegram, Discord, Slack, email and dashboard. High-stakes approvals require the PIN.
- **If WhatsApp is not ready (owner decision):** if Meta verification or the messaging tier is still pending when everything else passes, M1 can exit with **Telegram standing in for WhatsApp**.
  - The Critical and High routes that would use WhatsApp messages go to Telegram instead.
  - Telegram bots cannot place voice calls, so a **Critical alert call** temporarily uses a **regular phone call with text-to-speech** from the voice provider, alongside the Telegram message.
  - WhatsApp messaging and calling are switched on and tested as soon as Meta approves. The routing is a setting, so no code changes are needed.
- The emergency brake pauses and resumes a single agent and the whole company.
- A Supervisor test user receives a "human touch" item and is refused an owner-only approval.
- The Security & Audit agent detects and reports a planted anomaly directly to the owner.
- The owner reviews the audit trail for the week and can trace every decision.

## 7. Left to the builder

- Framework and library choices beyond the existing stack (Vite, React, TypeScript, PixiJS, zustand, Tailwind, Node server, MCP SDK), keeping that stack
- Database engine (SQLite suggested), schema details, and the migration from today's JSON state
- The mechanism for issuing per-agent secrets, within the sandbox-secret model
- Hash-chaining or another tamper-evidence method for the audit log
- Channel providers and SDKs (within §5), the scheduler implementation, and how to wake agents on a schedule
- The method for measuring AI spend
- UI details of the Owner Briefing, within layout A and the sections above
- Whether to keep the fork able to merge upstream JSM HQ changes. Keeping company features modular is preferred, but it is not required.

## 8. Open items for the owner (do not block design, block build steps)

1. The fork's logo (M0 start). Name chosen: Canoeney Labs (M0.1)
2. Initial thresholds: spend limits [X], escalation timings [X] hours
3. Always-on host and its monthly budget, after the virtualisation check
4. Agent accounts: Claude/ChatGPT subscriptions or metered API keys. This affects spend tracking and cost. **Before choosing subscriptions, check that running an autonomous, always-on company on a consumer subscription is allowed under that provider's current terms.** Subscriptions also have usage limits that the scheduler must work within.
5. Approving the WhatsApp calling provider and its cost after the builder's trial (WhatsApp calling itself is decided, see §9 item 3). Also: a dedicated +254 business number for the company, and starting Meta business verification early, because it has lead time.

## 9. Resolutions from the builder review (advisor calls, owner to check)

1. **Autonomy versus owner-gated categories.**
   - Each of the eight categories has an **owner-editable policy** in the charter. It defaults to "always ask".
   - The owner may set a threshold below which the CEO acts and reports. Example: spending up to [X] per month on a pre-approved vendor list.
   - These categories have a **hard floor that no policy can relax**:
     - #2 permissions (except the pre-approved list below)
     - #5 data leaving the company (Data Protection Act exposure)
     - #6 adding or retiring agents
     - #7 charter changes
     - #8 legal and regulatory matters
     - pausing or retiring Security & Audit
   - In M1, autonomy also governs non-gated areas: how often the CEO reports, which delegations it makes without telling the owner, and how voluntary escalations are batched.
2. **Which approvals need the dashboard PIN.** The rule is direction-based, so the safe direction is always easy:
   - **Approve, grant, resume or relax:** always needs the dashboard plus the PIN, for every gated category and for any change to the Security & Audit agent.
   - **Deny, pause or stop:** allowed from **any** registered channel without the PIN. Abuse of a hijacked channel can then only cause delay, never harm.
   - **Emergency brake:** *pause* works from any channel; *resume* needs the dashboard plus the PIN.
   - **Supervisors may pause** too (M1.11). Delegating any owner right to a supervisor needs the dashboard plus the PIN.
   - **Channel replies** can settle voluntary CEO escalations, acknowledgements, and denials.
   - The PIN is **never** typed into a channel.
3. **Voice call: WhatsApp calling is required (owner), and it is an alert only.**
   - Nothing is approved during a call. The call says something like "Critical item: <short title>. Check your dashboard." Inbound calls are never trusted for anything.
   - **Researched workflow (2026-11-09; verify before building):** Meta's **Cloud API Calling** supports *business-initiated* calls to a WhatsApp user who has **granted call permission**. Calls are billed per 6-second pulse, and the permission request is billed as a message. Call audio runs over **SIP or WebRTC**; it cannot be bridged to ordinary phone lines.
   - **Delivery:** use a Business Solution Provider that handles the media, such as Twilio (a Programmable Voice app can play an MP3 or text-to-speech), Infobip (a SIP trunk; it has a Nairobi presence), 360dialog or Telnyx. The provider choice belongs to the builder after a short trial.
   - **Flow:**
     1. HQ raises a Critical item.
     2. The provider API places a WhatsApp call from the company's **+254 business number** to the owner's WhatsApp.
     3. When the owner answers, text-to-speech reads the title.
     4. A WhatsApp message with details and a dashboard link follows.
     5. If the call goes unanswered, HQ retries per escalation rules and then uses the fallback below.
   - **Setup:** during onboarding the owner grants call permission once. HQ tracks the permission's status.
   - **Known constraints to verify against Meta's current docs** (third-party sources disagree):
     - Kenya is not on any exclusion list found, but this must be confirmed for a +254 number.
     - Some sources say outbound calling needs a **messaging tier of 2,000 or more**, which a new business number may not have.
     - Permission requests are reportedly limited to about 1 per 24 hours and 2 per 7 days.
     - Permission is reportedly **revoked after 4 consecutive unanswered calls**.
     - Grants may expire after 7 days unless set to permanent.
   - **Fallback (advisor):** if calling permission is missing, revoked or not yet available, HQ places an **ordinary phone call with text-to-speech** through the same provider, and sends a WhatsApp re-permission request. HQ must never silently fail to call on a Critical item. To avoid triggering revocation, HQ does not repeatedly call an unanswered owner on WhatsApp; it falls back instead.
   - Sources: [Meta Cloud API Calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling), [Meta calling pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/pricing/), [Twilio WhatsApp Business Calling](https://www.twilio.com/docs/voice/whatsapp-business-calling), [Infobip business-initiated calling](https://www.infobip.com/docs/whatsapp/whatsapp-business-calling/business-initiated-calling.md), [360dialog Calling](https://docs.360dialog.com/docs/messaging/calling), [Telnyx business calling](https://developers.telnyx.com/docs/messaging/whatsapp/business-calling).
4. **Everyday permission flows.**
   - All permission changes go through the decision engine.
   - To avoid approval fatigue, the owner keeps a **pre-approved list** in the charter, such as documentation sites, package registries and the stack's API domains. The CIO may grant items **on that list** to builder agents and must report each grant.
   - Anything off the list, anything for the CEO, CIO or Security, any MCP server, and any secret needs the owner, under rule 2 above.
5. **Audit scope.**
   - Everything HQ mediates goes in the tamper-evident trail: MCP tool calls, messages, decision requests, approvals and denials, permission changes, network decisions, scheduler runs, and the emergency brake.
   - Agents' own shell commands and file edits inside sandboxes are captured **best effort** (hooks, git history, proxy logs) and labelled as such in the trail, since the agent controls its hooks.
   - "Trace every decision" refers to HQ-mediated decisions.
   - Store client personal data in the trail by reference, never by value.
6. **Phone access to the dashboard.**
   - Reach the dashboard over a **private network** (for example Tailscale) from the owner's phone. It is not on the public internet. **(owner agreed to install the app)**
   - Only **channel webhooks** get a minimal public endpoint, which accepts provider callbacks and nothing else.
   - The **host-shell / Terminal feature is disabled for remote sessions.**
   - Passkeys are optional; password plus TOTP is enough for M1.
7. **The simulated week.** Build an **injectable clock** so the scheduler, escalation and expiry can run on a fast clock for automated red-team tests.
   - The exit gate is **one fast run** (all tests), plus **one real 7-day run** on the company-website project with the owner answering through each channel.
   - The owner approves the token budget for the real run as a spend decision.

## 10. The full programme (context only)

| # | Milestone | Exit gate |
|---|---|---|
| M0 | Foundations | Above |
| M1 | Company layer | Above |
| M2 | Delivery to production: CTO, Solutions engineer, Builders, QA, owner go-live approval, monitoring, rollback. **A Delivery security-reviewer role** runs `/security-review` on every PR and `/security-audit` (full mode, with a token cap) at go-live. **CodeRabbit** stays as the independent reviewer: it's a different vendor and model, so its errors don't correlate with the builders'. Private repos need a paid plan (a spend decision), and branch protection stays authoritative over its "passed" state. Its **repository security scanning** (dependencies, leaked secrets, vulnerabilities) is used if it comes with the same plan, otherwise it's a spend decision. **No CodeRabbit CLI pre-commit review (owner):** it would run the same model over the same diff the PR review already covers, at extra cost; `/security-review` in the sandbox is enough before a PR opens. **CodeRabbit's Slack and Discord agent stays disabled on company repositories**: it opens pull requests from chat, outside every HQ gate, and Slack and Discord are alert channels, so a hijacked channel would yield code changes (S11). Granted MCP servers are read-only or wrapped by HQ (S11); deploy secrets live in environments with required reviewers (S9) | The company's own website goes live through the pipeline |
| M3 | Client front office: intake channels, discovery interview, paid prototype preview and unlock, proposal and contract for owner signature, supervisor handoff, client memory, confidentiality guardrails. **Humanizer** for client-facing writers (proposals, client email). **REA** (reverse-engineering MCP server) for **recovering legacy apps** whose source code is lost, **only for targets the client owns or has written permission for**; anything else is category 8. It's a category 2 grant under S11. CodeRabbit reading client code is category 5 and needs a data processing agreement per client | A real client from the owner's contacts goes from first message to live in production |
| M4 | Back office (Accountant: books, invoices, eTIMS, M-Pesa reconciliation, KRA preparation; Customer service; revenue and selling dashboards) | A full month closed, with books verified by a human |
| M5 | Growth & strategy (Sales, Marketing, Research agents). Humanizer for Marketing and customer-facing writing. Research may use REA on competitor features under the same legal guardrail as M3 | A lead found by an agent becomes a paying client |
| M6 | Scale & harden (memory/context product trial such as Redis Iris, human support staff, wider autonomy, independent security assessment, disaster recovery) | Ongoing, reviewed quarterly |

From M2 onward, the owner covers missing departments by hand (sales through contacts, manual invoicing) so revenue can start before M3–M5 are complete.
