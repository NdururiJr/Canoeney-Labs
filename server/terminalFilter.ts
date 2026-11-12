// Terminal output from agents, before it reaches the browser (spec M0.7,
// surface S10; threat model SR-C-14, T-S10.5).
//
// Two escape sequences act outside the terminal: OSC 52 writes the browser's
// clipboard, and OSC 8 turns text into a link whose target the reader cannot
// see. Both are removed (an OSC 8 link keeps its visible text). Everything
// else, colours and cursor moves included, passes unchanged.
//
// The filter reads an OSC the way xterm.js does: it may start with ESC ] or
// the one-byte U+009D, end with BEL, ESC \ or U+009C, and its number is read
// as a number (so "08" is 8).
//
// Output arrives in chunks, so a sequence cut at the end of one is held until
// the next. A sequence that never ends is dropped after 64 KiB, never passed
// through.

const ESC = "\x1b";
const BEL = "\x07";
const OSC_C1 = "\u009d";
const ST_C1 = "\u009c";
const HOLD_LIMIT = 64 * 1024;
const REMOVED = new Set([52, 8]);

/** The index just past the terminator from `from`, or -1 when the input ends first. */
function terminatorEnd(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === BEL || s[i] === ST_C1) return i + 1;
    if (s[i] === ESC) {
      if (i + 1 >= s.length) return -1;
      if (s[i + 1] === "\\") return i + 2;
    }
  }
  return -1;
}

export class TerminalFilter {
  private carry = "";

  push(chunk: string): string {
    const s = this.carry + chunk;
    this.carry = "";
    let out = "";
    let i = 0;
    while (i < s.length) {
      // The next place an OSC could start.
      let at = -1;
      for (let j = i; j < s.length; j++) {
        if (s[j] === ESC || s[j] === OSC_C1) {
          at = j;
          break;
        }
      }
      if (at < 0) return out + s.slice(i);
      out += s.slice(i, at);
      let body: number; // where the OSC number starts
      if (s[at] === OSC_C1) body = at + 1;
      else {
        // Not enough input to tell what follows the ESC.
        if (at + 1 >= s.length) return out + this.hold(s.slice(at));
        if (s[at + 1] !== "]") {
          out += ESC;
          i = at + 1;
          continue;
        }
        body = at + 2;
      }
      let k = body;
      while (k < s.length && s[k] >= "0" && s[k] <= "9") k++;
      if (k >= s.length) return out + this.hold(s.slice(at));
      const code = k > body ? Number(s.slice(body, k)) : NaN;
      if (!REMOVED.has(code) || s[k] !== ";") {
        out += s.slice(at, k);
        i = k;
        continue;
      }
      const end = terminatorEnd(s, k + 1);
      if (end < 0) return out + this.hold(s.slice(at));
      i = end; // removed
    }
    return out;
  }

  /** Keeps an unfinished sequence for the next chunk; one too long to be honest is dropped. */
  private hold(rest: string): string {
    this.carry = rest.length > HOLD_LIMIT ? "" : rest;
    return "";
  }
}
