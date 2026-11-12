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

test("SR-C-14 [T-S10.5] an OSC number with leading zeros, or the one-byte OSC introducer, is still removed", () => {
  for (const seq of [`${ESC}]08;;https://evil.example${BEL}Open PR${ESC}]08;;${BEL}`, `\u009d8;;https://evil.example${BEL}Open PR\u009d8;;\u009c`, `\u009d052;c;cm0gLXJm${BEL}Open PR`]) {
    const out = all([`x${seq}y`]);
    assert.equal(out, "xOpen PRy", JSON.stringify(seq));
    // Split anywhere, same result.
    for (let cut = 1; cut < seq.length; cut++) assert.equal(all([`x${seq.slice(0, cut)}`, `${seq.slice(cut)}y`]), "xOpen PRy");
  }
});

// The real parser the page uses: does an OSC 8 or OSC 52 still reach it after the filter?
async function reachesXterm(chunks: string[]): Promise<boolean> {
  const { Terminal } = await import("@xterm/headless");
  const term = new Terminal({ allowProposedApi: true });
  let hit = false;
  term.parser.registerOscHandler(8, () => ((hit = true), true));
  term.parser.registerOscHandler(52, () => ((hit = true), true));
  const f = new TerminalFilter();
  for (const c of chunks) await new Promise<void>((r) => term.write(f.push(c), r));
  term.dispose();
  return hit;
}

test("SR-C-14 [T-S10.5] xterm's own parser sees no OSC 8 or 52 after the filter", async () => {
  const cases: string[][] = [
    [`${ESC}\x00]8;;https://evil.example${BEL}Open${ESC}]8;;${BEL}`],
    [`${ESC}\x7f]8;;https://evil.example${BEL}`],
    [`${ESC}\n]8;;https://evil.example${BEL}`],
    [`${ESC}]8\x01;;https://evil.example${BEL}`],
    [`${ESC}]\x008;;https://evil.example${BEL}`],
    [`${ESC}]5\x002;c;YQ==${BEL}`],
    [`\u009d\x008;;https://evil.example${BEL}`],
    [`${ESC}${ESC}]8;;a${BEL}]8;;https://evil.example${BEL}`],
    [ESC, `${ESC}]8;;a${BEL}`, `]8;;https://evil.example${BEL}`],
    [`${ESC}]08;;https://evil.example${BEL}`],
  ];
  for (const c of cases) assert.equal(await reachesXterm(c), false, JSON.stringify(c));
  // Every C0 control and DEL at every position of both sequences.
  for (const seq of [`${ESC}]8;;https://evil.example${BEL}`, `${ESC}]52;c;YQ==${BEL}`]) {
    for (let code = 0; code < 0x20; code++) {
      for (const ch of [String.fromCharCode(code), "\x7f"]) {
        for (let at = 1; at < seq.length; at++) {
          const input = seq.slice(0, at) + ch + seq.slice(at);
          assert.equal(await reachesXterm([input]), false, JSON.stringify(input));
        }
      }
    }
  }
});

test("the control check is real: without the filter, xterm does see OSC 8", async () => {
  const { Terminal } = await import("@xterm/headless");
  const term = new Terminal({ allowProposedApi: true });
  let hit = false;
  term.parser.registerOscHandler(8, () => ((hit = true), true));
  await new Promise<void>((r) => term.write(`${ESC}\x00]8;;https://evil.example${BEL}`, r));
  term.dispose();
  assert.equal(hit, true);
});
