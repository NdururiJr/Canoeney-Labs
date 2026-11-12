// Owner login for the dashboard (spec M0.7, surface S5; threat model SR-C-01
// to SR-C-03 and SR-C-18; docs/adr/0007-owner-login-and-dashboard.md).
//
//   GET  /auth/state            { enrolled, session }
//   POST /auth/enroll           first run only: setup code, name, password, PIN → TOTP secret
//   POST /auth/enroll/confirm   a first code from the authenticator app → session
//   POST /auth/login            account, password, code → session
//   POST /auth/logout
//
// Sessions live in memory (an HQ restart logs everyone out) under the SHA-256
// of the cookie value, so the value itself is never kept. Nothing here throws:
// anything that goes wrong is the uniform refusal.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Clock } from "./company/clock";
import type { HumanAccounts } from "./company/humanAccounts";
import type { AuditSink } from "./company/slots/types";
import type { HumanRole } from "./company/types";
import { base32Encode, otpauthUrl } from "./company/totp";

export interface DashboardSession {
  /** SHA-256 of the cookie value. */
  id: string;
  humanId: string;
  role: HumanRole;
  remote: boolean;
  createdAt: number;
  lastSeenAt: number;
}

export interface OwnerAuthLimits {
  idleMs: number;
  absoluteMs: number;
  /** Failed logins (or setup codes) from one source within `failureWindowMs` that lock it. */
  failuresToLock: number;
  failureWindowMs: number;
  lockMs: number;
  /** Wrong PINs per human that lock the PIN step. */
  pinFailuresToLock: number;
  pinLockMs: number;
}

export const DEFAULT_OWNER_AUTH_LIMITS: OwnerAuthLimits = {
  idleMs: 30 * 60_000,
  absoluteMs: 12 * 3600_000,
  failuresToLock: 5,
  failureWindowMs: 15 * 60_000,
  lockMs: 15 * 60_000,
  pinFailuresToLock: 5,
  pinLockMs: 15 * 60_000,
};

export const SESSION_COOKIE = "hq_session";
export const OWNER_ID = "owner";
const MINUTE = 60_000;
const ENROLL_TTL_MS = 10 * MINUTE;
const BODY_LIMIT = 4 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const WRONG = { error: "wrong password or code" };
const LOCKED = { error: "too many attempts; try again later" };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return a === "::1" || /^127\./.test(a);
}

function hostnameOf(host: string | undefined): string | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? status));
  }
}

export class OwnerAuth {
  readonly limits: OwnerAuthLimits;
  private readonly accounts: HumanAccounts;
  private readonly clock: Clock;
  private readonly audit: AuditSink;
  private readonly allowedOrigins: string[];
  private readonly setupFile: string;
  private sessions = new Map<string, DashboardSession>();
  private enders: ((sessionId: string) => void)[] = [];
  private failures = new Map<string, { start: number; count: number; lockedUntil: number }>();
  private failureRows = new Map<string, { start: number; pending: number }>();
  private pinFailures = new Map<string, { count: number; lockedUntil: number }>();
  /** The enrollment in progress: the confirm step must bring back its token before it expires. */
  private enrollment: { tokenHash: string; expiresAt: number } | null = null;

  constructor(o: { accounts: HumanAccounts; clock: Clock; audit: AuditSink; allowedOrigins: string[]; setupFile: string; limits?: Partial<OwnerAuthLimits> }) {
    this.accounts = o.accounts;
    this.clock = o.clock;
    this.audit = o.audit;
    this.allowedOrigins = o.allowedOrigins;
    this.setupFile = o.setupFile;
    this.limits = { ...DEFAULT_OWNER_AUTH_LIMITS, ...o.limits };
  }

  /**
   * While no owner is enrolled, makes sure the one-time setup code exists
   * (mode 0600) and returns its file. Null once an owner exists. The code is
   * never printed: whoever enrolls must be able to read this file on the host.
   */
  prepareSetup(): string | null {
    if (this.accounts.hasOwner()) {
      rmSync(this.setupFile, { force: true });
      return null;
    }
    if (!this.readSetupCode()) writeFileSync(this.setupFile, randomBytes(16).toString("base64url") + "\n", { mode: 0o600 });
    return this.setupFile;
  }

  onEnd(fn: (sessionId: string) => void): void {
    this.enders.push(fn);
  }

  /** The session the request's cookie names, if it is still within both lifetimes. An HTTP request counts as activity. */
  sessionFor(req: IncomingMessage): DashboardSession | null {
    try {
      const raw = cookieValue(req, SESSION_COOKIE);
      if (!raw || raw.length > 100) return null;
      const id = sha256(raw);
      return this.touch(id) ? (this.sessions.get(id) ?? null) : null;
    } catch {
      return null;
    }
  }

  /** Refreshes a session's idle timer. False (and the session ended) when it has run out. */
  touch(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const now = this.now();
    if (now - s.lastSeenAt > this.limits.idleMs || now - s.createdAt > this.limits.absoluteMs) {
      this.end(sessionId, "expired");
      return false;
    }
    s.lastSeenAt = now;
    return true;
  }

  /** Ends every session past a lifetime. HQ calls it every minute. */
  sweep(): void {
    const now = this.now();
    for (const s of [...this.sessions.values()]) {
      if (now - s.lastSeenAt > this.limits.idleMs || now - s.createdAt > this.limits.absoluteMs) this.end(s.id, "expired");
    }
  }

  /** Where the request came from, for lockouts: the address the proxy on this host saw, never one the client chose. */
  sourceOf(req: IncomingMessage): string {
    const socket = req.socket.remoteAddress ?? "unknown";
    const xff = req.headers["x-forwarded-for"];
    if (!isLoopback(socket) || typeof xff !== "string") return socket;
    const last = xff.split(",").at(-1)?.trim() ?? "";
    return isIP(last) ? last : socket;
  }

  /** Local only when nothing suggests a proxy and the host is loopback. Anything else is remote. */
  isRemote(req: IncomingMessage): boolean {
    if (!isLoopback(req.socket.remoteAddress)) return true;
    for (const h of Object.keys(req.headers)) if (h === "x-forwarded-for" || h === "forwarded" || h.startsWith("tailscale-")) return true;
    const host = hostnameOf(req.headers.host);
    return !host || !LOOPBACK_HOSTS.has(host);
  }

  /** Answers /auth/* and returns true, or returns false for other paths. Never throws. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/auth/")) return false;
    try {
      await this.route(req, res, url.pathname);
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(401, WRONG);
      if (!res.headersSent) this.json(res, e.status, e.body);
      else res.end();
    }
    return true;
  }

  private async route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method === "GET" && path === "/auth/state") {
      const s = this.sessionFor(req);
      return this.json(res, 200, { enrolled: this.accounts.hasOwner(), session: s ? { humanId: s.humanId, role: s.role, remote: s.remote } : null });
    }
    if (req.method !== "POST") throw new HttpError(405, { error: "method not allowed" });
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !this.allowedOrigins.includes(origin)) throw new HttpError(403, { error: "origin not allowed" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw new HttpError(415, { error: "send JSON" });

    if (path === "/auth/logout") {
      const s = this.sessionFor(req);
      if (s) this.end(s.id, "logout");
      res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return this.json(res, 200, { ok: true });
    }

    const source = this.sourceOf(req);
    // One login or enrollment step at a time per source, so a burst cannot get
    // past the lock before the earlier failures are counted.
    return this.serial(source, () => this.step(req, res, path, source));
  }

  private sourceQueues = new Map<string, Promise<void>>();

  private serial(source: string, fn: () => Promise<void>): Promise<void> {
    const run = (this.sourceQueues.get(source) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.sourceQueues.set(source, tail);
    // The queue entry goes once nothing is waiting behind it.
    void tail.then(() => {
      if (this.sourceQueues.get(source) === tail) this.sourceQueues.delete(source);
    });
    return run;
  }

  private async step(req: IncomingMessage, res: ServerResponse, path: string, source: string): Promise<void> {
    if (this.isLocked(source)) throw new HttpError(429, LOCKED);
    const body = await this.body(req);

    if (path === "/auth/login") {
      const r = await this.accounts.verifyLogin(String(body.account ?? OWNER_ID), String(body.password ?? ""), String(body.code ?? ""));
      if (!r.ok) {
        this.failed(source, r.reason);
        throw new HttpError(401, WRONG);
      }
      this.clearFailures(source);
      return this.startSession(req, res, r.humanId, r.role);
    }

    if (path === "/auth/enroll") {
      const code = this.readSetupCode();
      const given = String(body.setupCode ?? "");
      if (this.accounts.hasOwner() || !code || !this.same(given, code)) {
        this.failed(source, "setup-code");
        throw new HttpError(401, { error: "wrong setup code" });
      }
      let seed: Buffer;
      try {
        ({ seed } = await this.accounts.startEnrollment(
          { id: OWNER_ID, displayName: String(body.displayName ?? "").trim().slice(0, 60) || "Owner", role: "owner" },
          String(body.password ?? ""),
          String(body.pin ?? ""),
        ));
      } catch (err) {
        // The password and PIN rules: safe to show, they hold no input.
        throw new HttpError(400, { error: err instanceof Error ? err.message : "invalid" });
      }
      // Confirming needs this token, which only the browser that started enrollment has, within 10 minutes.
      const enrollToken = randomBytes(24).toString("base64url");
      this.enrollment = { tokenHash: sha256(enrollToken), expiresAt: this.now() + ENROLL_TTL_MS };
      return this.json(res, 200, { secret: base32Encode(seed), otpauth: otpauthUrl(seed, OWNER_ID), enrollToken });
    }

    if (path === "/auth/enroll/confirm") {
      const e = this.enrollment;
      const tokenOk = !!e && this.now() < e.expiresAt && this.same(String(body.enrollToken ?? ""), "", e.tokenHash);
      if (!tokenOk || this.accounts.hasOwner() || !(await this.accounts.confirmEnrollment(OWNER_ID, String(body.code ?? "")))) {
        this.failed(source, tokenOk ? "code" : "enroll-token");
        throw new HttpError(401, WRONG);
      }
      this.enrollment = null;
      rmSync(this.setupFile, { force: true });
      this.clearFailures(source);
      return this.startSession(req, res, OWNER_ID, "owner");
    }

    throw new HttpError(404, { error: "not found" });
  }

  private startSession(req: IncomingMessage, res: ServerResponse, humanId: string, role: HumanRole): void {
    const raw = randomBytes(32).toString("base64url");
    const now = this.now();
    const s: DashboardSession = { id: sha256(raw), humanId, role, remote: this.isRemote(req), createdAt: now, lastSeenAt: now };
    this.sessions.set(s.id, s);
    const https = (req.socket as { encrypted?: boolean }).encrypted === true || (isLoopback(req.socket.remoteAddress) && req.headers["x-forwarded-proto"] === "https");
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${raw}; HttpOnly; SameSite=Strict; Path=/${https ? "; Secure" : ""}`);
    this.audit.append({ actorKind: "human", actorId: humanId, action: "auth.login", data: { remote: s.remote } });
    this.json(res, 200, { humanId, role, remote: s.remote });
  }

  private end(sessionId: string, why: "logout" | "expired"): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    if (why === "logout") {
      try {
        this.audit.append({ actorKind: "human", actorId: s.humanId, action: "auth.logout" });
      } catch {
        /* the session ends whatever the audit does */
      }
    }
    for (const fn of this.enders) {
      try {
        fn(sessionId);
      } catch {
        /* one listener's failure does not keep a session open */
      }
    }
  }

  private isLocked(source: string): boolean {
    const f = this.failures.get(source);
    return !!f && this.now() < f.lockedUntil;
  }

  private clearFailures(source: string): void {
    this.failures.delete(source);
  }

  private failed(source: string, reason: string): void {
    const now = this.now();
    const prev = this.failures.get(source);
    const f = !prev || now >= prev.start + this.limits.failureWindowMs ? { start: now, count: 0, lockedUntil: 0 } : prev;
    f.count++;
    this.failures.set(source, f);
    // One row per source and minute; later failures in the minute are counted on the next row.
    const w = this.failureRows.get(source);
    if (!w || now >= w.start + MINUTE) {
      const data: Record<string, unknown> = { source, reason };
      if (w && w.pending > 0) data.suppressed = w.pending;
      this.failureRows.set(source, { start: now, pending: 0 });
      this.audit.append({ actorKind: "hq", actorId: "auth", action: "auth.login.failed", data });
    } else {
      w.pending++;
    }
    if (f.count >= this.limits.failuresToLock) {
      f.lockedUntil = now + this.limits.lockMs;
      f.start = now;
      f.count = 0;
      this.audit.append({ actorKind: "hq", actorId: "auth", action: "auth.locked", data: { source, minutes: Math.round(this.limits.lockMs / MINUTE) } });
    }
  }

  /**
   * The PIN step for one human: checked on the server, locked after repeated
   * failures (SR-C-05). Checks for one human run one at a time, so guesses sent
   * together cannot all read the lock before any of them counts.
   */
  checkPin(humanId: string, pin: unknown): Promise<"ok" | "wrong" | "locked"> {
    const run = (this.pinQueues.get(humanId) ?? Promise.resolve()).then(() => this.checkPinNow(humanId, pin));
    this.pinQueues.set(
      humanId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private pinQueues = new Map<string, Promise<void>>();

  private async checkPinNow(humanId: string, pin: unknown): Promise<"ok" | "wrong" | "locked"> {
    const now = this.now();
    const p = this.pinFailures.get(humanId);
    if (p && now < p.lockedUntil) return "locked";
    if (typeof pin === "string" && (await this.accounts.verifyPin(humanId, pin))) {
      this.pinFailures.delete(humanId);
      return "ok";
    }
    const f = p && now >= p.lockedUntil ? p : { count: 0, lockedUntil: 0 };
    f.count++;
    if (f.count >= this.limits.pinFailuresToLock) {
      f.count = 0;
      f.lockedUntil = now + this.limits.pinLockMs;
      this.audit.append({ actorKind: "human", actorId: humanId, action: "auth.pin-locked", data: { minutes: Math.round(this.limits.pinLockMs / MINUTE) } });
    }
    this.pinFailures.set(humanId, f);
    return "wrong";
  }

  private readSetupCode(): string | null {
    if (!existsSync(this.setupFile)) return null;
    const code = readFileSync(this.setupFile, "utf8").trim();
    return /^[A-Za-z0-9_-]{22}$/.test(code) ? code : null;
  }

  /** Compares a with b in constant time; or a's hash with a stored hash when one is given. */
  private same(a: string, b: string, bHash?: string): boolean {
    const x = Buffer.from(sha256(a));
    const y = Buffer.from(bHash ?? sha256(b));
    return x.length === y.length && timingSafeEqual(x, y);
  }

  private body(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > BODY_LIMIT) reject(new HttpError(413, { error: "too large" }));
        else chunks.push(c);
      });
      req.on("end", () => {
        try {
          const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          resolve(v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
        } catch {
          reject(new HttpError(400, { error: "bad request" }));
        }
      });
      req.on("error", reject);
    });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }

  private now(): number {
    return this.clock.now().getTime();
  }
}
