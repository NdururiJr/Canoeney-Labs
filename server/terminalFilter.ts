// Terminal output from agents, before it reaches the browser (spec M0.7,
// surface S10; threat model SR-C-14, T-S10.5).
//
// Two escape sequences act outside the terminal: OSC 52 writes the browser's
// clipboard, and OSC 8 turns text into a link whose target the reader cannot
// see. Both are removed (an OSC 8 link keeps its visible text). Everything
// else, colours and cursor moves included, passes unchanged.
//
// The filter reads escapes the way xterm.js's parser does
// (EscapeSequenceParser, OscParser):
// - an OSC starts with ESC ] or the one-byte U+009D, and C0 controls or DEL
//   between ESC and ] do not stop it;
// - inside an OSC, C0 controls are ignored, so they cannot split its number;
//   the number is read as a number ("08" is 8);
// - an OSC ends with BEL, U+009C or ESC (ESC \ is the usual form); CAN or SUB
//   abort it;
// - ESC followed by another ESC drops the first, so removing a sequence can
//   never join the bytes around it into a new one.
// The page also swallows OSC 8 and 52 in xterm itself (TerminalView), so the
// two layers must both fail for one to get through.
//
// Output arrives in chunks, so a sequence cut at the end of one is held until
// the next. A sequence that never ends is dropped after 64 KiB, never passed
// through.

const ESC = "\x1b";
const BEL = "\x07";
const CAN = "\x18";
const SUB = "\x1a";
const DEL = "\x7f";
const OSC_C1 = "\u009d";
const ST_C1 = "\u009c";
const HOLD_LIMIT = 64 * 1024;
const REMOVED = new Set([52, 8]);

/** A C0 control other than ESC, CAN and SUB, or DEL: xterm runs or ignores it without leaving the sequence. */
const isQuietControl = (ch: string) => (ch < " " && ch !== ESC && ch !== CAN && ch !== SUB) || ch === DEL;

type Scan =
  | { kind: "incomplete" }
  /** Emit `text` and continue at `end`. */
  | { kind: "pass"; text: string; end: number }
  /** Drop everything up to `end`. */
  | { kind: "remove"; end: number };

/** Reads one OSC whose number starts at `from`. `at` is where its introducer started. */
function scanOsc(s: string, at: number, from: number): Scan {
  let digits = "";
  let valid = true;
  let inNumber = true;
  for (let k = from; k < s.length; k++) {
    const ch = s[k];
    let end = -1;
    if (ch === BEL || ch === ST_C1 || ch === CAN || ch === SUB) end = k + 1;
    else if (ch === ESC) {
      if (k + 1 >= s.length) return { kind: "incomplete" };
      // ESC \ ends it; any other ESC ends it too and starts the next escape.
      end = s[k + 1] === "\\" ? k + 2 : k;
    }
    if (end >= 0) {
      const id = valid && digits ? Number(digits) : NaN;
      return REMOVED.has(id) ? { kind: "remove", end } : { kind: "pass", text: s.slice(at, end), end };
    }
    if (!inNumber || isQuietControl(ch)) continue;
    if (ch === ";") inNumber = false;
    else if (ch >= "0" && ch <= "9") digits += ch;
    else valid = false; // not a number xterm would act on
  }
  return { kind: "incomplete" };
}

/** Reads the escape that starts at `at` (an ESC or U+009D). */
function scanEscape(s: string, at: number): Scan {
  if (s[at] === OSC_C1) return scanOsc(s, at, at + 1);
  for (let j = at + 1; j < s.length; j++) {
    const ch = s[j];
    // A second ESC: xterm drops the first one. The controls in between still run.
    if (ch === ESC) return { kind: "pass", text: s.slice(at + 1, j), end: j };
    if (ch === CAN || ch === SUB) return { kind: "pass", text: s.slice(at, j + 1), end: j + 1 };
    if (isQuietControl(ch)) continue;
    if (ch === "]") return scanOsc(s, at, j + 1);
    // Any other escape (CSI and the rest): its first character after ESC goes out with it.
    return { kind: "pass", text: s.slice(at, j + 1), end: j + 1 };
  }
  return { kind: "incomplete" };
}

export class TerminalFilter {
  private carry = "";

  push(chunk: string): string {
    const s = this.carry + chunk;
    this.carry = "";
    let out = "";
    let i = 0;
    while (i < s.length) {
      let at = i;
      while (at < s.length && s[at] !== ESC && s[at] !== OSC_C1) at++;
      out += s.slice(i, at);
      if (at >= s.length) break;
      const r = scanEscape(s, at);
      if (r.kind === "incomplete") {
        this.hold(s.slice(at));
        break;
      }
      if (r.kind === "pass") out += r.text;
      i = r.end;
    }
    return out;
  }

  /** Keeps an unfinished sequence for the next chunk; one too long to be honest is dropped. */
  private hold(rest: string): void {
    this.carry = rest.length > HOLD_LIMIT ? "" : rest;
  }
}
