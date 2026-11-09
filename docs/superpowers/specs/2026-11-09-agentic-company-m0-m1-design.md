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
1. **New identity for the fork.** JSM HQ's trademarks forbid publishing a fork under that name or logo (see `TRADEMARKS.md`). Pick a new name and logo, update package metadata, and keep the MIT licence and attribution. Name: **open (owner)**.
2. **Unforgeable agent identity.** Today all agents share one project token (`server/paths.ts` `agentToken`) and identify themselves with a self-declared `X-HQ-Agent` header (`server/http.ts`). Any agent can therefore claim to be the lead. Replace this with **one secret per agent**, stored where only that agent's sandbox gets it, so HQ knows for certain which agent made each call. Every permission check in M1 depends on this.
3. **Company data model** (see §4): agents (with department, reporting line, human owner, autonomy), roles, permissions, owner charter, decision requests, human users, audit events, budgets and spend. Client and project entities must be defined now, even though they are only used from M3, so M1 code does not need reshaping later. **(advisor)**
4. **Durable storage.** HQ currently stores state in JSON files. M1 needs transactions and an append-only audit log, so move company state to an embedded database. SQLite is the suggestion **(advisor)**; the builder may choose an equivalent **(builder)**.
5. **Pluggable "slots"**, each with a simple local implementation now, so a product such as Redis Iris (memory, context gateway, intent routing, decision record, stream persistence) or an alternative can be tried in M6 without rewrites **(advisor)**:
   - `Memory`: per-agent and per-client long-term memory
   - `Knowledge`: company policies, playbooks and charter, read-only to agents
   - `Router`: classifies inbound messages and requests to a handler
   - `AuditSink`: where audit events are written
   - `Channel`: outbound alerts and inbound replies (see M1)
6. **Always-on hosting.** On Windows, HQ runs agents in-process and **agents stop when HQ stops** (`docs/how-it-works.md`), so a company cannot run from the owner's laptop. Choose and stand up an always-on Linux host (Docker Sandboxes needs Ubuntu 24.04+). **Before committing, verify that the host supports the virtualisation Docker Sandboxes needs**; many VPS plans do not. The owner keeps using the dashboard remotely. **(advisor; host choice and budget open, owner)**
7. **Owner authentication.** The owner will open the dashboard from a phone via links in alerts, so the current per-start browser token is not enough. Add a real login (password plus a second factor or passkey) and a separate **approval PIN** (or equivalent step-up check) for high-stakes approvals. **(advisor)**
8. **Threat model and security baseline**, written down, covering at least: prompt injection through any text an agent reads; agent impersonation; the CEO trying to widen its own powers; secrets leaking into sandboxes (keep HQ's existing rule that key values never enter a VM); a compromised alert channel (a hijacked WhatsApp, Telegram or email account); and denial of service through approval spam.
9. **Architecture decisions recorded** as short ADRs in `docs/adr/`.
10. **Least-privilege credentials for every agent (found in builder review; advisor).** Today the README has the owner store their full GitHub token as a *global* sandbox secret (`sbx secret set github …`, `globalKeys` in `server/sbx.ts`). Every sandbox can therefore merge, delete branches or change repo settings, so "HQ never merges" is only a convention. Local mode also runs an agent on the host, where it can read HQ state and other agents' secrets. M0 must:
    - give each agent its **own scoped GitHub identity** (a GitHub App installation or a fine-grained token: push to its own branches and open PRs, but not merge or administer the repo);
    - turn on **branch protection** on `main` so merges need the owner;
    - remove global secrets that allow consequential actions;
    - **forbid Local mode for company agents** (the CEO, CIO, Security & Audit, and any agent with company tools). Local mode may remain for plain coding experiments outside the company.

    The enforcement principle in §M1.2 applies to credentials agents already hold, not only to new HQ tools.
11. **Permissions and company configuration move out of the repo.** Per-agent permissions (`sandbox.allow`, `mcp`, `isLead`, `roleMd`, secret names) and everything company-level currently live in the committed `.jsmhq/config.json`, which agents can change through a PR. Move them into HQ's company store. Only the owner, or an approved decision request, can change them. The repo may keep a non-authoritative export for readability.
12. **The company sits above projects (advisor).** One HQ "company" instance manages **many project repos**. In M3 each client gets its own repo. Company state (charter, agents, approvals, audit, users, clients) lives at company level. Project state (boards, tasks, PRs) lives per project. The CEO, CIO and Security & Audit agents get company-level workspaces, not repo clones. **HQ's own source code is off-limits to company agents**: they can never open PRs against the code that enforces their limits. Improving HQ is the owner's job, done outside the company. M1 runs one project: **the company's own website repo**, which M2 then takes to production.

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
   - **Escalation:** if there is no answer within [X] hours, re-send at the next level up. **Silence is never approval. A request that expires counts as "no".** **(advisor; owner agreed)**
   - **Verification:** a channel reply ("yes") may approve low-risk items. Spending, permissions, contracts and charter changes need confirmation in the dashboard with the approval PIN. **(advisor; owner agreed)**
   - Every request also appears in the dashboard, which is the record of what was asked and decided. **(advisor; owner agreed)**
   - Generalise the existing **Action items** (`server/actionItems.ts`, the `ask_user` tool) into this engine rather than building a parallel system **(advisor)**.
5. **Alert channels: all of them, fully built** **(owner)**: WhatsApp (messages and voice calls), Telegram, Discord, Slack, email, and dashboard notifications. Each one implements the `Channel` slot: send an alert, receive a reply, and link the reply to a decision request. Inbound replies are only accepted from the owner's (or supervisors') registered accounts and are treated as untrusted input to be parsed, never as instructions to agents. Provider choice is **(builder)**, subject to the constraints in §5.
6. **AI CEO agent.** It replaces the "lead" at the top. The existing lead becomes the **CTO**, who keeps planning delivery tasks, and the CEO sits above it. **(advisor; owner agreed via org chart)**
   - It reads the charter and turns goals into plans across departments.
   - It delegates through HQ tools, which extend today's boards, tasks and messages to departments.
   - It raises decision requests and writes the **Owner Briefing**.
   - It **runs on a schedule**, not only when messaged. At minimum: a daily planning cycle, a daily summary, and a weekly owner briefing. HQ owns the scheduler and wakes the CEO. **(advisor)**
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
9. **Append-only audit trail.** Every tool call, decision request, approval or denial, message between agents, charter change and blocked attempt is recorded. It must be **tamper-evident** (for example hash-chained) **(advisor)**. Agents cannot write to it except through HQ recording their actions. The owner and the Security & Audit agent can search it.
10. **Emergency brake.** The owner can pause one agent or the whole company, from the dashboard and from a channel command that needs step-up verification. While paused, scheduled cycles do not run. Resuming is owner-only.
11. **Human supervisor roster.** Human users have roles: **Owner** (all powers) and **Supervisor**, who receives "human touch" items such as client escalations but **does not** hold owner decision rights unless the owner delegates a specific one. In M1 only the owner exists, but the roles, the routing ("send to the supervisors list", not "send to the owner") and the permission checks are built and tested. **(owner: future support team; advisor: model)**
12. **Owner Briefing dashboard (layout A, chosen by the owner).** A dedicated page, separate from the pixel office, which stays one click away.
    - **"Needs you"** is pinned at the top and sorted by urgency, with tags: Critical, Approve, Human touch.
    - A KPI row: revenue this month, active projects, leads in the pipeline, AI spend this month **(AI spend: advisor)**.
    - Sections: ongoing work, completed (last 7 days), pipeline (leads needing you), what's selling, client feedback, trends and new opportunities **(owner)**.
    - Sections whose data arrives in later milestones (revenue, pipeline, selling, feedback, trends) are built with their final layout and show a clear "available from M3/M4/M5" state, not fake data.
    - **The page must work on a phone**, because alerts link to it. The pixel office keeps its desktop minimum width. **(advisor)**
13. **Departments in the org chart** (v2, agreed): Owner → AI CEO → Internal IT (CIO), Delivery (CTO, Solutions engineer, Builders, QA), Clients (Customer service), Finance (Accountant), Growth (Sales, Marketing), Strategy (Research), with Security & Audit independent and reporting to both the CEO and the owner. **M1 builds the department structure and reporting lines** (agents have a department and a manager, and the office and briefing group by department). It only **staffs the CEO, CIO and Security & Audit**, plus the existing CTO and builders as they work today. Other departments are staffed in their own milestones.

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
- **Honesty policy (owner + advisor):** agents never reveal how the company or its systems are structured ("confidential how") and never claim to be human ("honest what"). The company's terms will state that it uses AI-assisted delivery under human oversight. This is mostly enforced from M3, but the charter's standing instructions and the `Knowledge` slot must carry it from M1.
- **Licence and trademark:** MIT code may be modified freely. The JSM HQ name and logo must not be used for the fork (M0 goal 1).
- **Budget:** self-funded, with possible investors later. Prefer providers with free or low entry tiers. Every recurring cost goes to the owner as a spend decision.
- **WhatsApp:** sending from software requires the official WhatsApp Business Platform (Meta business verification has lead time). Automated **voice calls** may need a separate voice provider. **Confirm current feasibility and cost before building** (builder researches; owner approves the cost).
- **Agents run Claude Code or Codex** as HQ already supports. The CEO, CIO and Security agents run the same way, in sandboxes.
- **Windows is the owner's desktop OS, but production runs on Linux** (M0 goal 6).

## 6. Exit gates

**M0 is done when:** the new name and identity are in place; per-agent identity is live, and a test proves that agent A cannot act as agent B; the data model, storage and slots exist with tests; HQ runs on the always-on host and survives a restart without losing agents; owner login and the approval PIN work; the threat model and ADRs are written; and the **owner approves the M0 review**.

**M1 is done when** a **simulated company week** runs on the always-on host, in which:
- The CEO reads the charter, plans, delegates to the CIO, Security & Audit, and the CTO and builders, runs its scheduled cycles, and delivers a weekly Owner Briefing.
- **Red-team tests pass. Each of the following is blocked and audited:** the CEO edits the charter; the CEO or CIO grants a permission without approval; an agent impersonates another; a gated action is reworded or relayed through another agent; an approval is forged through a spoofed channel reply; a request expires without an answer (it must resolve to "no"); the CEO tries to pause or silence Security & Audit.
- The owner receives, and answers, at least one decision request through **each** channel: WhatsApp message, WhatsApp call, Telegram, Discord, Slack, email and dashboard. High-stakes approvals require the PIN.
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

1. The fork's new name and logo (M0 start)
2. Initial thresholds: spend limits [X], escalation timings [X] hours
3. Always-on host and its monthly budget, after the virtualisation check
4. Agent accounts: Claude/ChatGPT subscriptions or metered API keys (this affects spend tracking and cost)
5. Approving the WhatsApp calling provider and its cost after the builder's trial (WhatsApp calling itself is decided, see §9 item 3). Also: a dedicated +254 business number for the company, and starting Meta business verification early, because it has lead time.

## 9. Resolutions from the builder review (advisor calls, owner to check)

1. **Autonomy versus owner-gated categories.**
   - Each of the eight categories has an **owner-editable policy** in the charter. It defaults to "always ask".
   - The owner may set a threshold below which the CEO acts and reports. Example: spending up to [X] per month on a pre-approved vendor list.
   - These categories have a **hard floor that no policy can relax**: #2 permissions (except the pre-approved list below), #6 adding or retiring agents, #7 charter changes, and pausing or retiring Security & Audit.
   - In M1, autonomy also governs non-gated areas: how often the CEO reports, which delegations it makes without telling the owner, and how voluntary escalations are batched.
2. **Which approvals need the dashboard PIN.** The rule is direction-based, so the safe direction is always easy:
   - **Approve, grant, resume or relax:** always needs the dashboard plus the PIN, for every gated category and for any change to the Security & Audit agent.
   - **Deny, pause or stop:** allowed from **any** registered channel without the PIN. Abuse of a hijacked channel can then only cause delay, never harm.
   - **Emergency brake:** *pause* works from any channel; *resume* needs the dashboard plus the PIN.
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
| M2 | Delivery to production (CTO, Solutions engineer, Builders, QA, security review, owner go-live approval, monitoring, rollback) | The company's own website goes live through the pipeline |
| M3 | Client front office (intake channels, discovery interview, paid prototype preview and unlock, proposal and contract for owner signature, supervisor handoff, client memory, confidentiality guardrails) | A real client from the owner's contacts goes from first message to live in production |
| M4 | Back office (Accountant: books, invoices, eTIMS, M-Pesa reconciliation, KRA preparation; Customer service; revenue and selling dashboards) | A full month closed, with books verified by a human |
| M5 | Growth & strategy (Sales, Marketing, Research agents) | A lead found by an agent becomes a paying client |
| M6 | Scale & harden (memory/context product trial such as Redis Iris, human support staff, wider autonomy, independent security assessment, disaster recovery) | Ongoing, reviewed quarterly |

From M2 onward, the owner covers missing departments by hand (sales through contacts, manual invoicing) so revenue can start before M3–M5 are complete.
