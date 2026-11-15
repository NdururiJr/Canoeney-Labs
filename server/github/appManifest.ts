// The manifest HQ prepares for an agent's own GitHub App (M0-E, ADR 0010). The
// owner posts it to GitHub, which creates the App with exactly these
// permissions: push and open pull requests, and nothing that administers the
// repo, changes workflows or reads secrets (SR-E-02). No webhook: hook_attributes
// is left out, because GitHub requires its url whenever it is present.

/** The App's permissions. Also what each installation token asks for (Task 2). */
export const APP_PERMISSIONS = { contents: "write", pull_requests: "write", metadata: "read" } as const;

const MAX_NAME = 34;

export function manifestFor(o: { project: string; agentId: string; repo: string; origin: string; rand: string }): Record<string, unknown> {
  const tail = `-${o.rand}`;
  const base = `hq-${o.project}-${o.agentId}`.slice(0, MAX_NAME - tail.length).replace(/-+$/, "");
  return {
    name: base + tail,
    url: `https://github.com/${o.repo}`,
    redirect_url: `${o.origin}/github-app`,
    public: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [],
  };
}
