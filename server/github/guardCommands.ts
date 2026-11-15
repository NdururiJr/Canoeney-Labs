// The dashboard's commands for a project repo's GitHub protection (M0-E).
// Applying it changes the repo's settings with the owner's own login, so it
// needs the PIN; confirming a spending limit records a fact HQ cannot read.
import type { Company } from "../company";
import type { CommandSpec } from "../dashboard";
import type { Finding, RepoWatch } from "./repoGuard";

export function guardCommands(o: { company: Company; slug: string; watch: RepoWatch | null; apply: () => Promise<Finding[]> }): Record<string, CommandSpec> {
  const need = () => {
    if (!o.watch) throw new NoRepo();
    return o.watch;
  };
  const explain = (err: unknown) => (err instanceof NoRepo ? err.message : null);
  return {
    applyRepoGuard: {
      role: "owner",
      pin: true,
      explain,
      run: async (ctx) => {
        const watch = need();
        const before = (await watch.check()).filter((f) => f.fixable).map((f) => f.name);
        const after = new Set((await o.apply()).map((f) => f.name));
        o.company.audit.append({ actorKind: "human", actorId: ctx.actor.id, action: "github.guard-applied", target: o.slug, data: { fixed: before.filter((n) => !after.has(n)) } });
        await watch.check();
      },
    },
    confirmSpendingLimit: {
      role: "owner",
      pin: true,
      explain,
      run: async (ctx) => {
        const watch = need();
        const at = o.company.clock.now().toISOString();
        o.company.db
          .prepare(
            `INSERT INTO repo_guard(project_id, spending_confirmed_at, spending_confirmed_by) VALUES (?, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET spending_confirmed_at = excluded.spending_confirmed_at, spending_confirmed_by = excluded.spending_confirmed_by`,
          )
          .run(o.slug, at, ctx.actor.id);
        o.company.audit.append({ actorKind: "human", actorId: ctx.actor.id, action: "github.spending-confirmed", target: o.slug, data: { authority: "pin" } });
        await watch.check();
      },
    },
    recheckRepoGuard: { role: "owner", explain, run: async () => void (await need().check()) },
  };
}

/** Whether the owner confirmed the project's Actions spending limit (SR-E-14). */
export function spendingConfirmed(company: Company, slug: string): boolean {
  return !!company.db.prepare("SELECT spending_confirmed_at FROM repo_guard WHERE project_id = ?").get<{ spending_confirmed_at: string | null }>(slug)?.spending_confirmed_at;
}

class NoRepo extends Error {
  constructor() {
    super("This project has no GitHub repo to protect.");
  }
}
