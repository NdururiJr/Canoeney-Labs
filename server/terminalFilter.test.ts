import assert from "node:assert/strict";
import { test } from "node:test";
import { sbxRunArgs } from "./sessions";
import { TerminalFilter } from "./terminalFilter";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;
const OSC52 = (t: string) => `${ESC}]52;c;${Buffer.from("rm -rf ~").toString("base64")}${t}`;
const link = (t: string) => `${ESC}]8;;https://evil.example/${t}click here${ESC}]8;;${t}`;

const all = (chunks: string[]) => {
  const f = new TerminalFilter();
  return chunks.map((c) => f.push(c)).join("");
};

test("SR-C-14 [T-S10.5] OSC 52 and OSC 8 never reach the browser terminal", () => {
  for (const t of [BEL, ST]) {
    const out = all([`before ${OSC52(t)} middle ${link(t)} after`]);
    assert.equal(out, "before  middle click here after");
    assert.ok(!out.includes(`${ESC}]52`) && !out.includes(`${ESC}]8`));
  }
});

test("SR-C-14 [T-S10.5] an OSC 52 split across chunks is still removed", () => {
  const text = `a${OSC52(BEL)}b${link(ST)}c`;
  for (let cut = 1; cut < text.length; cut++) {
    assert.equal(all([text.slice(0, cut), text.slice(cut)]), "aclick herec".replace("click here", "bclick here"), `cut at ${cut}`);
  }
});

test("colour and cursor sequences pass unchanged", () => {
  // A Claude Code screen fragment: colours, bold, cursor moves, a window title (OSC 0) and erase-line.
  const screen = `${ESC}[?25l${ESC}[1m${ESC}[38;5;174m✻ Thinking…${ESC}[0m${ESC}[2K${ESC}[1G${ESC}]0;claude${BEL}${ESC}[3A> esc to interrupt${ESC}[?25h`;
  assert.equal(all([screen]), screen);
  assert.equal(all([screen.slice(0, 7), screen.slice(7)]), screen);
});

test("a sequence that never ends is dropped, not passed through", () => {
  const f = new TerminalFilter();
  const out = f.push(`ok${ESC}]52;c;${"A".repeat(70_000)}`) + f.push("more");
  assert.equal(out.includes("AAAA"), false);
  assert.ok(out.startsWith("ok"));
});

test("SR-C-15 [T-S10.6] a company agent's launch does not point BROWSER at the sandbox opener", () => {
  const args = sbxRunArgs({ name: "hq-p-ana", size: [], envFile: "/tmp/env", sbxAgent: "claude", dir: "/w", launchArgs: ["--x"] });
  assert.ok(!args.some((a) => a.includes("BROWSER")), args.join(" "));
  assert.deepEqual(args.slice(0, 3), ["run", "--name", "hq-p-ana"]);
  assert.ok(args.includes("--env-file"));
});
