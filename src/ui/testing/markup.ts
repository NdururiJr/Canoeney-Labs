// Reads static markup from react-dom/server for tests: which text sits
// outside every element marked with an attribute (data-agent-text).
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&nbsp;": " " };

export function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#x27|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/** The text of `html` that is not inside an element carrying `attr`. */
export function textOutside(html: string, attr = "data-agent-text"): string {
  const stack: boolean[] = [];
  let out = "";
  let last = 0;
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    if (!stack.some(Boolean)) out += decode(html.slice(last, m.index));
    last = tag.lastIndex;
    const [, closing, name, rest] = m;
    if (closing) stack.pop();
    else if (!VOID.has(name.toLowerCase()) && !rest.endsWith("/")) stack.push(new RegExp("[ \\t\\n]" + attr + "(=|[ \\t\\n]|$)").test(rest));
  }
  if (!stack.some(Boolean)) out += decode(html.slice(last));
  return out;
}

/** The opening tags in `html`, for checks on element names and attributes. */
export function openingTags(html: string): string[] {
  return [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)].map((m) => m[0]);
}
