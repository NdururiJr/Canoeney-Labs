import type { SbxApproval } from "../../data/types";
import { AgentText, authoredTitle } from "../agentText";

/** One blocked request. Its title and host come from the agent's sandbox, so the tooltip names the agent. */
export function ApprovalRow({ approval: a, author, busy, onAct }: { approval: SbxApproval; author: string; busy: boolean; onAct: (id: string, decision: "allow" | "dismiss") => void }) {
  return (
    <li className="flex items-center gap-2 py-0.5">
      <span className="min-w-0 flex-1 truncate font-term text-[16px]" title={authoredTitle(author, `${a.title ?? a.host} — ${a.detail}`)}>
        <AgentText inline author={author} text={a.title ?? a.host} />
      </span>
      <button className="btn px-1.5 text-[11px]" disabled={busy} onClick={() => onAct(a.id, "allow")}>
        Allow
      </button>
      <button className="btn px-1.5 text-[11px]" disabled={busy} onClick={() => onAct(a.id, "dismiss")}>
        Dismiss
      </button>
    </li>
  );
}
