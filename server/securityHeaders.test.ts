import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { securityHeaders } from "./securityHeaders";
import { browserFor, dumpDom } from "./testing/browser";
import { makeHq, ORIGIN, type Hq } from "./testing/hqFixture";

function assertHeaders(h: Headers | Record<string, string>, where: string) {
  const get = (k: string) => (h instanceof Headers ? h.get(k) : h[k.toLowerCase()]);
  const csp = get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/, where);
  assert.match(csp, /script-src 'self'(;|$)/, where);
  assert.match(csp, /frame-ancestors 'none'/, where);
  assert.match(csp, /object-src 'none'/, where);
  assert.doesNotMatch(csp, /unsafe-eval/, where);
  assert.equal(get("x-content-type-options"), "nosniff", where);
  assert.equal(get("referrer-policy"), "no-referrer", where);
  assert.equal(get("x-frame-options"), "DENY", where);
}

/** The raw response to a refused WebSocket upgrade, headers included. */
function refusedUpgrade(hq: Hq): Promise<Record<string, string>> {
  const { port } = new URL(hq.url);
  return new Promise((resolve, reject) => {
    const s = connect(Number(port), "127.0.0.1", () =>
      s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${ORIGIN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`),
    );
    let raw = "";
    s.on("data", (d) => (raw += d));
    s.on("close", () => {
      const [status, ...lines] = raw.split("\r\n\r\n")[0].split("\r\n");
      const headers: Record<string, string> = { status };
      for (const l of lines) {
        const i = l.indexOf(":");
        if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      resolve(headers);
    });
    s.on("error", reject);
  });
}

test("SR-C-12 [T-S10.4 T-S5.8] every response carries the security headers", async (t) => {
  const hq0 = await makeHq(t);
  const dist = join(hq0.scratch, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div><script src=/app.js></script>");
  writeFileSync(join(dist, "app.js"), "document.title = 'app';");
  const hq = await makeHq(t, { distDir: dist });
  for (const path of ["/", "/app.js", "/api/health", "/auth/state"]) assertHeaders((await fetch(hq.url + path)).headers, path);
  const notFound = await fetch(hq.url + "/nothing", { method: "POST" });
  assert.equal(notFound.status, 404);
  assertHeaders(notFound.headers, "404");
  const mcp = await fetch(hq.url + "/mcp", { method: "POST", body: "{}" });
  assert.equal(mcp.status, 401);
  assertHeaders(mcp.headers, "refused /mcp");
  const login = await fetch(hq.url + "/auth/login", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
  assertHeaders(login.headers, "refused login");
  assert.equal(login.headers.get("cache-control"), "no-store");
  const up = await refusedUpgrade(hq);
  assert.match(up.status, / 401 /);
  assertHeaders(up, "refused upgrade");
});

test("the CSP lets the page's own WebSocket through, and leaves a strange Host out", () => {
  assert.match(securityHeaders("127.0.0.1:7420")["Content-Security-Policy"], /connect-src 'self' ws:\/\/127\.0\.0\.1:7420 wss:\/\/127\.0\.0\.1:7420;/);
  const odd = securityHeaders("evil.example; script-src *")["Content-Security-Policy"];
  assert.match(odd, /connect-src 'self';/);
  assert.doesNotMatch(odd, /evil/);
});

test("SR-C-12 [T-S10.4] an inline script is blocked in a real browser", async (t) => {
  const bin = browserFor(t);
  if (!bin) return;
  const page = `<!doctype html><html><body><div id="x">before</div><script>document.getElementById("x").textContent = "ran"</script></body></html>`;
  let withHeaders = false;
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...(withHeaders ? securityHeaders(req.headers.host) : {}) });
    res.end(page);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  // The control proves the probe works: without the policy the script runs.
  assert.match(await dumpDom(bin, url), /id="x">ran</);
  withHeaders = true;
  const blocked = await dumpDom(bin, url);
  assert.match(blocked, /id="x">before</);
  assert.doesNotMatch(blocked, />ran</);
});
