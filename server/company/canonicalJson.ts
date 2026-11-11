// Deterministic JSON for hashing and storage: sorted keys, no whitespace,
// undefined-valued keys omitted. Anything that cannot round-trip through JSON
// unambiguously is refused with TypeError; callers pass ISO strings, not Dates.
export function canonicalJson(value: unknown): string {
  return write(value, []);
}

function write(value: unknown, stack: object[]): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      // undefined (top level or array element), bigint, function, symbol
      throw new TypeError(`canonicalJson: unsupported ${typeof value} value`);
  }
  const obj = value as object;
  if (stack.includes(obj)) throw new TypeError("canonicalJson: circular reference");
  stack.push(obj);
  try {
    if (Array.isArray(obj)) return "[" + obj.map((v) => write(v, stack)).join(",") + "]";
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("canonicalJson: only plain objects are supported");
    }
    const rec = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(rec).sort()) {
      const v = rec[key];
      if (v === undefined) continue;
      parts.push(JSON.stringify(key) + ":" + write(v, stack));
    }
    return "{" + parts.join(",") + "}";
  } finally {
    stack.pop();
  }
}
