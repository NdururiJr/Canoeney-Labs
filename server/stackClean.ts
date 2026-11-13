// Stack choices, checked against the catalog (src/data/stack.ts). The stack goes
// into every agent's role, so anything from the browser or an imported file is
// cleaned here first.
import { STACK_CATEGORIES, stackTool, type StackChoice, type StackConfig } from "../src/data/stack";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * A stack from the browser or an imported file, checked against the catalog, with
 * lengths capped. Null when nothing is chosen. A docs link must be http(s).
 */
export function cleanStack(raw: unknown): StackConfig | null {
  const input = (raw ?? {}) as Partial<StackConfig>;
  const choice = (c: unknown, category: string): StackChoice | null => {
    const v = (c ?? {}) as Partial<StackChoice>;
    const id = str(v.id, 40);
    const known = id === "other" || stackTool(id)?.category === category;
    if (!known) return null;
    const out: StackChoice = { id };
    if (typeof v.where === "string" && v.where.trim()) out.where = str(v.where, 120).trim();
    if (id === "other") {
      if (typeof v.name === "string" && v.name.trim()) out.name = str(v.name, 60).trim();
      if (typeof v.docsUrl === "string" && /^https?:\/\//i.test(v.docsUrl.trim())) out.docsUrl = str(v.docsUrl, 300).trim();
    }
    return out;
  };
  const frameworks = (Array.isArray(input.frameworks) ? input.frameworks : []).slice(0, 10).map((f) => choice(f, "framework")).filter((f): f is StackChoice => !!f);
  const tools: StackConfig["tools"] = {};
  for (const c of STACK_CATEGORIES) {
    const picked = choice(input.tools?.[c.id], c.id);
    if (picked) tools[c.id] = picked;
  }
  return frameworks.length || Object.keys(tools).length ? { frameworks, tools } : null;
}

/** Every free-text value of a stack (names, where, docs links), for showing as agent text. */
export function stackValues(stack: StackConfig): string[] {
  const all = [...stack.frameworks, ...Object.values(stack.tools)].filter((c): c is StackChoice => !!c);
  return all.flatMap((c) => [c.name, c.where, c.docsUrl].filter((x): x is string => !!x));
}
