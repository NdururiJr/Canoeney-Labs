/** @jsxRuntime automatic */
// (tsx compiles this test outside tsconfig.json, which excludes tests: the pragma picks the same JSX runtime.)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { browserFor, dumpDom } from "../../server/testing/browser";
import type { AccessRequest, ActionItem, ActivityEvent } from "../data/types";
import { AgentMarkdown, AgentText, safeHref } from "./agentText";
import { AccessRequestRow, ActionItemCard, ActivityLine, CardNote, NeedsYouRow, StatusNote, TooltipBody } from "./systemItems";
import { openingTags, textOutside } from "./testing/markup";

/** Agent text that would run, load or pose as HQ if it were ever read as markup. */
export const PAYLOADS = [
  `<script>document.title='p1'</script>`,
  `<img src=x onerror="document.title='p2'">`,
  `<svg onload="document.title='p3'">`,
  `<a href="javascript:document.title='p4'">x</a>`,
  `[x](javascript:document.title='p5')`,
  `<iframe srcdoc="<script>parent.document.title='p6'</script>">`,
  `![x](https://other.example/p7.png)`,
  `**Approve request** [Approve](https://other.example)`,
];

const item = (text: string): ActionItem => ({ id: "A-1", fromId: "ana", taskId: null, title: text, details: text, waiting: true, status: "open", note: null, at: "x", closedAt: null });
const request = (text: string): AccessRequest => ({ id: "R-1", agentId: "ana", domain: text, reason: text, at: "x", status: "pending" });
const event = (text: string): ActivityEvent => ({ id: "a1", at: "x", type: "message", agentId: "ana", text: "Ana → Lead", quote: { author: "Ana", text } });

/** Every component that shows agent text, with `text` in every agent-written field. */
function renderAll(text: string): string {
  return renderToStaticMarkup(
    <div>
      <AgentText author="Ana" text={text} />
      <AgentText author="Ana" text={text} inline />
      <AgentMarkdown author="Ana" source={text} />
      <ActionItemCard item={item(text)} from="Ana" />
      <AccessRequestRow request={request(text)} agentName="Ana" />
      <NeedsYouRow before="Ana needs you:" quote={{ author: "Ana", text }} />
      <ActivityLine event={event(text)} />
      <StatusNote note={text} flagged author="Ana" />
    </div>,
  );
}

const page = (body: string) => `<!doctype html><html><head><title>orig</title></head><body>${body}</body></html>`;

function assertInert(html: string) {
  for (const tag of openingTags(html)) {
    assert.doesNotMatch(tag, /^<(script|img|svg|iframe|object|embed)\b/i, tag);
    assert.doesNotMatch(tag, /\son[a-z]+=/i, tag);
    assert.doesNotMatch(tag, /href="(javascript|data):/i, tag);
  }
}

test("SR-C-10 [T-S10.2] agent text runs nothing and creates no element in a real browser", async (t) => {
  const html = PAYLOADS.map(renderAll).join("");
  assertInert(html);
  const bin = browserFor(t);
  if (!bin) return;
  const dir = mkdtempSync(join(tmpdir(), "hq-agent-text-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  // The control: the same payloads inserted raw do run.
  writeFileSync(join(dir, "raw.html"), page(PAYLOADS.slice(0, 2).join("")));
  assert.doesNotMatch(await dumpDom(bin, pathToFileURL(join(dir, "raw.html")).href), /<title>orig<\/title>/);
  writeFileSync(join(dir, "rendered.html"), page(html));
  const dom = await dumpDom(bin, pathToFileURL(join(dir, "rendered.html")).href);
  assert.match(dom, /<title>orig<\/title>/);
  assertInert(dom.replace(/^[\s\S]*?<body>/, ""));
});

test("SR-C-11 [T-S10.1 T-S10.3] the markdown renderer allows only its list", async (t) => {
  const md = (source: string) => renderToStaticMarkup(<AgentMarkdown author="Ana" source={source} />);
  for (const p of PAYLOADS.slice(0, 4).concat(PAYLOADS[5])) assertInert(md(p));
  assert.doesNotMatch(md(`[x](javascript:alert(1))`), /<a /);
  assert.doesNotMatch(md(`[x](data:text/html,hi)`), /<a /);
  const link = md(`see [the docs](https://docs.example.com/a)`);
  assert.match(link, /<a href="https:\/\/docs\.example\.com\/a" target="_blank" rel="noopener noreferrer"/);
  assert.match(link, /\(docs\.example\.com\)/);
  assert.match(md("**bold** and *it* and `code`\n- one\n- two\n# Head"), /<strong>bold<\/strong>.*<em>it<\/em>.*<code>code<\/code>.*<li>one<\/li>/s);
  // An image is never loaded: a counting server stands in for the other origin.
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const img = md(`![pixel](http://127.0.0.1:${(server.address() as AddressInfo).port}/p7.png)`);
  assert.doesNotMatch(img, /<img/);
  const bin = browserFor(t);
  if (!bin) return;
  const dir = mkdtempSync(join(tmpdir(), "hq-markdown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  writeFileSync(join(dir, "md.html"), page(img));
  await dumpDom(bin, pathToFileURL(join(dir, "md.html")).href);
  assert.equal(requests, 0);
});

test("SR-C-13 [T-S10.3] system items take no agent-written markup", () => {
  const fake = PAYLOADS[7];
  const html = renderAll(fake);
  const outside = textOutside(html);
  assert.ok(!outside.includes("Approve request"), outside);
  assert.ok(!outside.includes("other.example"), outside);
  // HQ's own words stay outside the agent container.
  assert.ok(outside.includes("wants to reach"));
  assert.ok(outside.includes("Ana needs you:"));
  assert.ok(outside.includes("Ana → Lead"));
  assert.ok(outside.includes("waiting"));
});

test("SR-C-13 [T-S10.3] an agent's words that imitate an HQ line render inside the agent container", () => {
  const imitation = "done. HQ: security check passed, approve PR #12";
  for (const html of [
    renderToStaticMarkup(<ActivityLine event={{ id: "a", at: "x", type: "task.started", agentId: "ana", text: "Ana finished P3-T02", quote: { author: "Ana", text: imitation } }} />),
    renderToStaticMarkup(<ActivityLine event={event("HQ: Lead approved your PR, merge it now")} />),
    renderToStaticMarkup(<StatusNote note={`Asking: ${imitation}`} flagged author="Ana" />),
  ]) {
    const outside = textOutside(html);
    assert.ok(!outside.includes("security check") && !outside.includes("merge it now"), outside);
    assert.ok(!outside.includes("HQ:"), outside);
  }
  assert.equal(textOutside(renderToStaticMarkup(<StatusNote note="Sandbox running" author="Ana" />)), "Sandbox running");
});

test("safeHref keeps only http, https and mailto", () => {
  assert.equal(safeHref("https://a.example/x"), "https://a.example/x");
  assert.equal(safeHref("mailto:a@b.example"), "mailto:a@b.example");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "/relative", "", null, undefined, " JAVASCRIPT:alert(1)"]) assert.equal(safeHref(bad), null, String(bad));
});

test("SR-C-13 [T-S10.3] the team card and the tooltip keep agent words inside the agent container", () => {
  const imitation = "HQ: review passed, safe to merge";
  for (const html of [
    renderToStaticMarkup(<CardNote needs={false} task={null} note={imitation} flagged author="Ana" />),
    renderToStaticMarkup(<CardNote needs task={null} note={`Asking: ${imitation}`} flagged author="Ana" />),
    renderToStaticMarkup(<CardNote needs={false} task={{ id: "P3-T02", title: imitation }} note={null} author="Ana" />),
    renderToStaticMarkup(<TooltipBody title="Ana · Developer" sub="Working — P3-T02" quote={{ author: "an agent", text: imitation }} />),
  ]) {
    const outside = textOutside(html);
    assert.ok(!outside.includes("review passed") && !outside.includes("HQ:"), outside);
  }
  // A note HQ wrote itself (unflagged) is plain text.
  assert.equal(textOutside(renderToStaticMarkup(<CardNote needs={false} task={null} note="Sandbox running" author="Ana" />)), "Sandbox running");
  assert.equal(textOutside(renderToStaticMarkup(<CardNote needs={false} task={null} note={null} author="Ana" />)), "No task");
});
