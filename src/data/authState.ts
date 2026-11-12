// Which data source the page uses, and who is logged in (M0-C).
//
// The page HQ serves talks to HQ, and when HQ cannot be reached it says so:
// it never shows the demo office, with its invented agents and tasks, on the
// device used for approvals. The demo is for `pnpm dev` with no HQ running.

export type SourceChoice = "hq" | "mock" | "unreachable";

export interface AuthState {
  enrolled: boolean;
  session: { humanId: string; role: "owner" | "supervisor"; remote: boolean } | null;
}

export async function chooseSource(fetchState: () => Promise<Response>, dev: boolean): Promise<SourceChoice> {
  try {
    const r = await fetchState();
    if (r.ok && (r.headers.get("content-type") ?? "").includes("application/json")) {
      await r.json();
      return "hq";
    }
  } catch {
    /* no HQ */
  }
  return dev ? "mock" : "unreachable";
}

let chosen: SourceChoice = "mock";
/** Set once by main.tsx, before the office store is loaded. */
export const setChosenSource = (c: SourceChoice) => {
  chosen = c;
};
export const chosenSource = () => chosen;

export async function fetchAuthState(): Promise<AuthState | null> {
  try {
    const r = await fetch("/auth/state", { credentials: "same-origin", cache: "no-store" });
    return r.ok ? ((await r.json()) as AuthState) : null;
  } catch {
    return null;
  }
}

/** POSTs to /auth/…; the browser adds the Origin header HQ checks. */
export async function authPost(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  try {
    const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let json: Record<string, unknown> = {};
    try {
      json = (await r.json()) as Record<string, unknown>;
    } catch {
      /* no body */
    }
    return { status: r.status, json };
  } catch {
    return { status: 0, json: { error: "Can't reach HQ." } };
  }
}
