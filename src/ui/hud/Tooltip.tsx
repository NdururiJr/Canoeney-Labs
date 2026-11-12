import { useUi } from "../../store/ui";
import { TooltipBody } from "../systemItems";

export function Tooltip() {
  const hover = useUi((s) => s.hover);
  if (!hover) return null;
  return (
    <div
      className="pointer-events-none fixed z-30 max-w-[340px] border-2 border-ink bg-cream px-2 py-0.5 text-[14px] shadow-[0_3px_0_rgba(36,26,46,0.45)]"
      style={{ left: hover.x + 14, top: hover.y + 16 }}
    >
      <TooltipBody title={hover.title} sub={hover.sub} quote={hover.quote} />
    </div>
  );
}
