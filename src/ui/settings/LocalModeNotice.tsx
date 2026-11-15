import type { AgentMode } from "../../data/types";

/**
 * Shown for an agent stored in Local mode, which HQ no longer runs (SR-E-06). The mode list
 * has only Sandbox, so choosing it fires no change: this button is the way to switch.
 */
export function LocalModeNotice({ onSwitch }: { onSwitch: (patch: { mode: AgentMode }) => void }) {
  return (
    <div className="flex items-center gap-2 border-t-2 border-dashed border-cream-3 px-3 py-1 text-[12px] text-muted">
      <span className="flex-1">This agent is set to Local mode, which HQ no longer runs.</span>
      <button className="btn px-2 text-[12px]" onClick={() => onSwitch({ mode: "sandbox" })}>Switch to Sandbox</button>
    </div>
  );
}
