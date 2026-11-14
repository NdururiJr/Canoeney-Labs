// GitHub's REST API, as HQ calls it with an App's JWT or an installation token
// (M0-E). An interface, so tests use a fake and never reach the network.

export interface GitHubApi {
  request<T>(method: string, path: string, o?: { body?: unknown; token?: string; jwt?: string }): Promise<{ status: number; json: T | null }>;
}

/** The real client. The User-Agent names no person or product (GitHub requires one). */
export function fetchGitHubApi(base = "https://api.github.com"): GitHubApi {
  return {
    async request<T>(method: string, path: string, o: { body?: unknown; token?: string; jwt?: string } = {}) {
      const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "hq-github-client" };
      const bearer = o.jwt ?? o.token;
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (o.body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(`${base}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(20_000) });
      let json: T | null = null;
      try {
        json = (await res.json()) as T;
      } catch {
        /* no body */
      }
      return { status: res.status, json };
    },
  };
}
