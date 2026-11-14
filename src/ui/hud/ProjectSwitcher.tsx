import type { ProjectSummary } from "../../data/types";

const LABEL: Record<ProjectSummary["state"], (name: string) => string> = {
  open: (name) => name,
  missing: (name) => `${name} (folder missing)`,
  "hq-source": (name) => `${name} (HQ's own source, not opened)`,
};

/**
 * The project this dashboard views (M0-D2). Only an open project can be chosen.
 * The owner also gets "Add project" when `onAdd` is given. Props only, so the
 * top bar and the welcome own the wiring.
 */
export function ProjectSwitcher({
  projects,
  current,
  isOwner,
  onSelect,
  onAdd,
}: {
  projects: ProjectSummary[];
  current: string | null;
  isOwner: boolean;
  onSelect: (id: string) => void;
  onAdd: (() => void) | null;
}) {
  const open = new Set(projects.filter((p) => p.state === "open").map((p) => p.id));
  return (
    <div className="flex items-center gap-1.5">
      <select
        className="field w-[170px] py-0 text-[14px]"
        aria-label="Project"
        value={current ?? ""}
        onChange={(e) => {
          if (open.has(e.target.value)) onSelect(e.target.value);
        }}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id} disabled={p.state !== "open"}>
            {LABEL[p.state](p.name)}
          </option>
        ))}
      </select>
      {isOwner && onAdd && (
        <button className="btn whitespace-nowrap text-[14px]" onClick={onAdd} title="Add a repo on this machine as a project (needs your PIN)">
          Add project
        </button>
      )}
    </div>
  );
}
