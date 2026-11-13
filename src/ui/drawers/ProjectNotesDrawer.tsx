import type { ProjectNotesState } from "../../data/types";
import { AgentText } from "../agentText";
import { ProjectNotesRow } from "../systemItems";

/**
 * A changed CLAUDE.md, waiting for the owner (D1, SR-D-07). The text is shown as
 * agent text, preformatted rather than rendered, so the owner approves exactly
 * the bytes HQ will store. Agents keep the last approved version until then.
 */
export function ProjectNotesDrawer({ notes, repo, onApprove }: { notes: ProjectNotesState; repo: string; onApprove: (sha256: string) => void }) {
  const pending = notes.pending;
  if (!pending) return null;
  const source = `CLAUDE.md in ${repo}`;
  return (
    <section className="mb-4 flex flex-col gap-2" data-system-item="project-notes">
      <ProjectNotesRow repo={repo} approvedVersion={notes.approved?.version ?? null} />
      <AgentText author={source} text={pending.text} className="font-term" />
      <div>
        <button type="button" className="btn" onClick={() => onApprove(pending.sha256)}>
          Approve with PIN
        </button>
      </div>
    </section>
  );
}
