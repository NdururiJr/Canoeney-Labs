// Keeps the owner's view of the project notes current: the approved copy, and a
// pending one when the repo's CLAUDE.md differs from it. HQ refreshes this at
// startup and before each agent starts (SR-D-07).
import type { ProjectNotesState } from "../src/data/types";
import type { Company } from "./company";
import type { Hub } from "./hub";

export function refreshProjectNotes(hub: Hub, company: Company): ProjectNotesState {
  const approved = company.notes.current(hub.slug);
  const read = company.notes.readFrom(hub.repo.root);
  const pending = "content" in read && read.sha256 !== approved?.sha256 ? { sha256: read.sha256, text: read.content } : null;
  const state: ProjectNotesState = { approved: approved ? { version: approved.version, approvedAt: approved.approvedAt } : null, pending };
  const before = JSON.stringify(hub.snap.projectNotes ?? null);
  const newPending = pending && pending.sha256 !== hub.snap.projectNotes?.pending?.sha256;
  hub.snap.projectNotes = state;
  // Once per new version: agents keep the approved copy (or none) until the owner reads this one.
  if (newPending) hub.activity("config", null, "CLAUDE.md in the repo changed. Agents keep the approved version until you read and approve it in Action items.");
  if (JSON.stringify(state) !== before) hub.emit({ type: "projectNotes.updated", projectNotes: structuredClone(state) });
  return state;
}
