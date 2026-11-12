// 127.0.0.1 only. Routes:
//   GET  /ws?token=…            browser WebSocket (browser token)
//   POST /hook/<agent>/<event>  Claude Code hooks (the agent's own secret)
//   POST /mcp                   the Team MCP (the agent's own secret)
//   GET  /api/health
//   GET  /*                     the built UI (dist/), when present

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { OfficeEvent } from "../src/data/source";
import type { AgentAuth, CheckResult } from "./agentAuth";
import type { Company } from "./company";
import { handleHook } from "./hooks";
import type { Hub } from "./hub";
import type { Inbox } from "./inbox";
import { handleMcp } from "./mcp";
import type { Planner } from "./planner";
import { log } from "./lib/log";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".json": "application/json",
};

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface Options {
  hub: Hub;
  inbox: Inbox;
  planner: Planner;
  port: number;
  browserToken: string;
  /** Resolves /mcp and /hook callers from their own secret (M0-B). */
  agentAuth: AgentAuth;
  company: Company;
  distDir: string | null;
  allowedOrigins: string[];
  commands: Record<string, (...args: unknown[]) => unknown>;
}

export function startHttp(o: Options) {
  const send = (res: ServerResponse, code: number, body: string, type = "text/plain") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(body);
  };
  // Every refusal looks the same, whatever failed (SR-B-04).
  const refuse = (res: ServerResponse, r: Extract<CheckResult, { ok: false }>) =>
    send(res, r.status, r.status === 401 ? "unauthorized" : "too many requests");
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname.startsWith("/hook/")) {
      const [, , claimed, event] = url.pathname.split("/");
      const who = o.agentAuth.check(req, "hook", decode(claimed ?? ""));
      if (!who.ok) return refuse(res, who);
      try {
        const body = await readBody(req);
        const r = handleHook(o.hub, o.inbox, who.agent.agentId, event ?? "", body ? JSON.parse(body) : {});
        if (!r.ok) return send(res, 404, "");
        if (r.response) return send(res, 200, JSON.stringify(r.response), "application/json");
        res.writeHead(204);
        return void res.end();
      } catch {
        return send(res, 400, "bad request");
      }
    }

    // Team MCP: the agent is whoever its secret says. An X-HQ-Agent header (sent
    // by agents started before M0-B) is only a claim that must match.
    if (url.pathname === "/mcp") {
      const header = req.headers["x-hq-agent"];
      const who = o.agentAuth.check(req, "mcp", header === undefined ? null : String(header));
      if (!who.ok) return refuse(res, who);
      if (req.method === "GET" || req.method === "DELETE") return send(res, 405, "stateless server");
      try {
        const raw = await readBody(req, 1024 * 1024);
        return await handleMcp(o.hub, o.planner, o.company, who.agent, req, res, raw ? JSON.parse(raw) : undefined);
      } catch {
        return res.headersSent ? void res.end() : send(res, 400, "bad request");
      }
    }

    if (url.pathname === "/api/health") return send(res, 200, JSON.stringify({ ok: true }), "application/json");

    if (req.method === "GET" && o.distDir) {
      const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
      let file = join(o.distDir, rel);
      if (!file.startsWith(o.distDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(o.distDir, "index.html");
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      return void createReadStream(file).pipe(res);
    }
    send(res, 404, "not found");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin ?? "";
    const token = url.searchParams.get("token") ?? "";
    // Token + origin: another website in your browser can't drive HQ.
    if (url.pathname !== "/ws" || !safeEqual(token, o.browserToken) || (origin && !o.allowedOrigins.includes(origin))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onClient(ws));
  });

  function onClient(ws: WebSocket) {
    const sendEvent = (e: OfficeEvent) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(e));
    sendEvent({ type: "snapshot", snapshot: o.hub.snap });
    const unsub = o.hub.subscribe(sendEvent);
    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { cmd?: string; args?: unknown[] };
        const fn = msg.cmd ? o.commands[msg.cmd] : undefined;
        if (!fn) return log.warn("unknown command", msg.cmd);
        await fn(...(Array.isArray(msg.args) ? msg.args : []));
      } catch (err) {
        log.warn("command failed:", err instanceof Error ? err.message : err);
      }
    });
    ws.on("close", () => unsub());
  }

  return new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => resolve(server));
  });
}
