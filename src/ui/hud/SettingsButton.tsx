import type { OfficeSnapshot } from "../../data/types";
import type { SettingsTab } from "../../store/ui";

type Guards = Pick<OfficeSnapshot, "githubGuard" | "skillsGuard">;

/** The Settings tab that holds a finding: the project repo's GitHub protection, then the skills repo's check. Null while both are clean. */
export function guardTab(snap: Guards): SettingsTab | null {
  if (snap.githubGuard?.findings.length) return "project";
  if (snap.skillsGuard?.findings.length) return "skills";
  return null;
}

/**
 * The top bar's Settings button, marked while the GitHub guard or the skills repo check has
 * findings (M1's alert channel takes them later). The mark is a plain "!" with a label, not colour alone.
 */
export function SettingsButton({ snap, onOpen }: { snap: Guards; onOpen: (tab: SettingsTab) => void }) {
  const tab = guardTab(snap);
  return (
    <button
      className="btn text-[14px]"
      style={tab ? { background: "#ffec27" } : undefined}
      onClick={() => onOpen(tab ?? "team")}
      title={tab ? "A protection check found something to look at" : undefined}
    >
      Settings
      {tab && <b aria-label="Needs your attention: a protection check has findings"> !</b>}
    </button>
  );
}
