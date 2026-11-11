# M0 (Foundations): build overview

**Spec:** `docs/superpowers/specs/2026-11-09-agentic-company-m0-m1-design.md` (M0 goals 1–18, §2b, §6).

M0 has 18 goals that fall into separate pieces of software. Each piece gets its own plan, and each plan produces working, tested software by itself. **Only M0-A is written in detail now.** Each later plan is written when the plan before it is merged, because it builds on that plan's real interfaces, not on guesses.

## Sub-plans, in build order

| Plan | Covers (spec) | Depends on | Blocked by an owner decision? |
|---|---|---|---|
| **M0-A Company core** (`2026-11-11-m0a-company-core.md`) | M0.13 test harness; M0.3 data model; M0.4 SQLite store; M0.5 slots; the audit chain (M1.9 foundation, M0.16 anchor head); first ADRs (M0.9) | none | No |
| **M0-B Agent identity and roles** | M0.2 per-agent secrets on `/mcp` and `/hook` (S1, S2); M0.14 roles mapped to tool sets, replacing `isLead` | A | No |
| **M0-C Owner login and a safe dashboard** | M0.7 login, TOTP, approval PIN, escaping, sanitised markdown, CSP (S10); M0.14 per-command human-role checks and owner-started changes as direct PIN-confirmed actions (S5); §9.6 terminal disabled for remote sessions | A | No |
| **M0-D Company above projects** | M0.11 config and `plan.json` move to the company store (S7); M0.12 many projects under one company, HQ source off-limits, company website as first project; M0.14 company-level workspaces | A, B | No |
| **M0-E Least-privilege GitHub** | M0.10 scoped identity per agent, branch protection, no global consequential secrets, no Local mode for company agents (S3); merge-by as a gated setting; Actions hardening (S9) | B, D | **Yes:** GitHub App or bot accounts, and whether private-repo branch protection needs a paid plan (spend) |
| **M0-F Per-role skills** | M0.18 skills vendored into company-owned forks, pinned by hash, installed per role, changes as category 2 (S12) | A, B | No (the company skill repo is created by the owner) |
| **M0-G Always-on operations** | M0.6 Linux host; M0.15 external uptime check, public health path, daily heartbeat; M0.16 encrypted nightly off-host backup, daily audit-head anchor, tested restore | A (and C for the public endpoint) | **Yes:** host and monthly budget, after the virtualisation check |
| **M0-H Rename** | M0.1 new name and logo; M0.17 `~/.jsmhq`, `.jsmhq/`, bin name, `X-HQ-Agent` header | A (it adds `HQ_DIRNAME`) | **Yes:** the name |

M0-H can run at any point once the name is chosen; M0-A puts the folder name behind one constant so the rename is cheap.

## Owner track (runs alongside the code)

| When | Owner action | Spec |
|---|---|---|
| Now | Start Meta business verification and get a dedicated +254 business number (lead time) | M1.5, §8.5 |
| Now | Check that candidate hosts support Docker Sandboxes' virtualisation, then choose the host and budget | M0.6, §8.3 |
| Now | Choose the fork's name and logo | M0.1, §8.1 |
| After M0-A merges, before M0-B starts | Run the threat model (STRIDE, attack trees, requirement extraction, mitigation mapping) over S1–S12 in your own session, so M0-B onward write tests that trace to threats | M0.8 |
| Before M0-E | Decide the GitHub identity model and any paid-plan spend | M0.10 |
| Before M0-F | Create the company-owned skills repository | M0.18 |
| M0 exit | Run `/security-audit` in full mode on the fork; fix or accept each finding; approve the M0 review | M0.8, §6 |

## M0 exit gate → plan

| §6 M0 exit item | Plan |
|---|---|
| Test harness runs | A |
| New name and identity | H |
| Agent A cannot act as agent B | B |
| Data model, storage and slots with tests | A |
| Least-privilege GitHub, branch protection, Actions hardening on the website repo | E |
| Company configuration and `plan.json` in the company store | D |
| Role tool sets and per-command role checks | B, C |
| Per-role skills vendored and pinned | F |
| Always-on host, survives a restart without losing agents | G (store survival is proven in A) |
| Uptime check and daily heartbeat | G |
| Encrypted backup restored in a test | G |
| Owner login, approval PIN, escaping and CSP | C |
| Threat model with tests traced to threats; ADRs | Owner track; ADRs in every plan |
| `/security-audit` run, findings fixed or accepted | Owner track |
| Owner approves the M0 review | Owner |
