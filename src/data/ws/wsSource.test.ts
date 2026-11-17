// PR #12 review (M0-E): the GitHub return (?code&state) completes the App once. A reconnect, or a second
// connect() on the same source, must not send the one-time code again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWsSource } from "./wsSource";

/** A socket the test drives: it records what is sent and lets the test open and close it. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: { cmd?: string; args?: unknown[] }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

/** Runs `fn` with a browser that came back from GitHub at /github-app?code=c1&state=s1. */
async function atGithubReturn(fn: (timers: (() => void)[]) => void | Promise<void>) {
  const g = globalThis as Record<string, unknown>;
  const saved = { location: g.location, history: g.history, WebSocket: g.WebSocket, window: g.window };
  const timers: (() => void)[] = [];
  const replaced: string[] = [];
  FakeSocket.all = [];
  Object.assign(g, {
    location: { pathname: "/github-app", search: "?code=c1&state=s1", protocol: "http:", host: "127.0.0.1:7420" },
    history: { replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url) },
    WebSocket: FakeSocket,
    window: { setTimeout: (fn: () => void) => timers.push(fn), clearTimeout: () => {} },
  });
  try {
    await fn(timers);
    assert.deepEqual(replaced, ["/"], "the code leaves the address bar once read");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  }
}

const completes = (s: FakeSocket) => s.sent.filter((m) => m.cmd === "completeGithubIdentity");

test("a reconnect does not send the GitHub return again", async () => {
  await atGithubReturn((timers) => {
    const source = createWsSource();
    const stop = source.connect(() => {});
    const first = FakeSocket.all[0];
    first.open();
    assert.deepEqual(completes(first).map((m) => m.args), [["s1", "c1"]], "sent once, when the socket opens");
    // The socket drops and HQ reconnects (the retry timer fires).
    first.drop();
    timers.shift()?.();
    const second = FakeSocket.all[1];
    assert.ok(second, "a new socket was opened");
    second.open();
    assert.deepEqual(completes(second), [], "the one-time code is not sent again");
    // Nor on a third, nor from a second connect() on the same source.
    second.drop();
    timers.shift()?.();
    FakeSocket.all[2].open();
    assert.deepEqual(completes(FakeSocket.all[2]), []);
    stop();
    source.connect(() => {});
    FakeSocket.all[3].open();
    assert.deepEqual(completes(FakeSocket.all[3]), []);
  });
});
