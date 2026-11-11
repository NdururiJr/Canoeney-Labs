import { REPLY_CODE_PATTERN } from "../replyCode";
import type { InboundMessage, Route, Router } from "./types";

export class LocalRouter implements Router {
  async route(m: InboundMessage): Promise<Route> {
    const codes = new Set<string>();
    for (const hit of m.text.matchAll(new RegExp(REPLY_CODE_PATTERN.source, "gi"))) {
      codes.add(hit[0].slice(1).toUpperCase());
    }
    if (codes.size === 0) return { kind: "unrouted", reason: "no-code" };
    if (codes.size > 1) return { kind: "unrouted", reason: "ambiguous" };
    return { kind: "decision-reply", code: [...codes][0] };
  }
}
