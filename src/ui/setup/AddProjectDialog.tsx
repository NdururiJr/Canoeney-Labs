import { useState } from "react";
import { officeActions } from "../../store/office";

/**
 * Adds a repo on this machine as a project. HQ asks for the PIN, as for any
 * change that relaxes a control, and refuses HQ's own source and folders
 * inside HQ's home.
 */
export function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const [path, setPath] = useState("");
  const add = () => {
    if (!path.trim()) return;
    officeActions.addProject(path.trim());
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(36,26,46,0.55)] p-4" role="dialog" aria-modal="true" aria-label="Add project">
      <div className="panel w-[min(560px,100%)] p-4">
        <h3 className="mb-1 text-[20px] font-bold">Add a project</h3>
        <p className="mb-3 text-[13px] text-muted">
          The full path of a git repo on this machine. HQ asks for your PIN next. HQ's own source, and folders inside HQ's home, can't be projects.
        </p>
        <input
          className="field mb-3 w-full font-term text-[16px]"
          placeholder="C:\Users\you\code\website  or  /home/you/code/website"
          aria-label="Repo folder"
          value={path}
          autoFocus
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!path.trim()} onClick={add}>
            Add project
          </button>
        </div>
      </div>
    </div>
  );
}
