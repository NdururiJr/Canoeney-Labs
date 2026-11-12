// Terminal output from agents, before it reaches the browser (spec M0.7,
// surface S10; threat model SR-C-14, T-S10.5).
//
// Two escape sequences act outside the terminal: OSC 52 writes the browser's
// clipboard, and OSC 8 turns text into a link whose target the reader cannot
// see. Both are removed (an OSC 8 link keeps its visible text). Everything
// else, colours and cursor moves included, passes unchanged.
//
// Output arrives in chunks, so a sequence cut at the end of one is held until
// the next. A sequence that never ends is dropped after 64 KiB, never passed
// through.

const ESC = "\x1b";
const BEL = "\x07";
const HOLD_LIMIT = 64 * 1024;
const REMOVED = new Set(["52", "8"]);

/** The index just past the terminator (BEL or ESC \) from `from`, or -1 when the input ends first. */
function terminatorEnd(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === BEL) return i + 1;
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
      const esc = s.indexOf(ESC, i);
      if (esc < 0) return out + s.slice(i);
      out += s.slice(i, esc);
      // Not enough input to tell what follows the ESC.
      if (esc + 1 >= s.length) return out + this.hold(s.slice(esc));
      if (s[esc + 1] !== "]") {
        out += ESC;
        i = esc + 1;
        continue;
      }
      // An OSC sequence: its number decides.
      let k = esc + 2;
      while (k < s.length && s[k] >= "0" && s[k] <= "9") k++;
      if (k >= s.length) return out + this.hold(s.slice(esc));
      const code = s.slice(esc + 2, k);
      if (!REMOVED.has(code) || s[k] !== ";") {
        out += s.slice(esc, k);
        i = k;
        continue;
      }
      const end = terminatorEnd(s, k + 1);
      if (end < 0) return out + this.hold(s.slice(esc));
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
