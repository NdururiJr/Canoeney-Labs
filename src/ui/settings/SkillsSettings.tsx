// Settings → Skills (M0-F): the pinned skills, each role's set, and pinning a commit of the skills repo from a preview.
// Everything from the repo (skill names, file paths, script names) is shown as plain React text, never as markup
// (SR-C escaping). A link is rendered only when it points at https://github.com/.

import { useState } from "react";
import type { SkillSpec } from "../../data/stack";
import type { SkillsGuardState, SkillsPinFlow, SkillsPinPreview, SkillsState } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { safeHref } from "../agentText";
import { SectionTitle } from "../kit";

/** The company's skills repo, used until one is pinned. */
export const DEFAULT_SKILLS_REPO = "NdururiJr/canoeney-skills";

/** A commit is exactly 40 hex characters. Preview stays off until it is one. */
export const isCommitSha = (v: string): boolean => /^[0-9a-f]{40}$/.test(v.trim().toLowerCase());

/** A link is shown only when it points at GitHub; anything else from the server is dropped. */
export const commitLink = (url: string | null | undefined): string | null => (typeof url === "string" && url.startsWith("https://github.com/") ? url : null);

/** `names` with `name` in or out, sorted and without repeats. */
export const toggleName = (names: string[], name: string, on: boolean): string[] => {
  const rest = names.filter((n) => n !== name);
  return (on ? [...rest, name] : rest).sort();
};

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((n) => b.includes(n));

function ExternalLink({ to, children }: { to: string | null; children: string }) {
  const safe = safeHref(commitLink(to));
  if (!safe) return null;
  return (
    <a className="underline" href={safeHref(safe) ?? undefined} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function NameList({ label, names }: { label: string; names: string[] }) {
  return (
    <div className="text-[13px]">
      <b>{label}:</b>{" "}
      {names.length === 0 ? (
        <span className="text-muted">none</span>
      ) : (
        names.map((n) => (
          <span key={n} className="chip mr-1 font-term text-[14px]">
            {n}
          </span>
        ))
      )}
    </div>
  );
}

const fileCount = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/** What pinning a commit would do. Confirm sends back exactly the previewed repo, commit and lock hash. */
export function PinPreviewView({
  preview,
  error,
  onConfirm,
  onCancel,
}: {
  preview: SkillsPinPreview;
  /** Why the last Confirm was refused, in HQ's words. */
  error?: string;
  onConfirm: (repo: string, commit: string, lockHash: string) => void;
  onCancel: () => void;
}) {
  const refused = preview.refused.length > 0;
  return (
    <section className="border-[3px] border-ink bg-white p-3">
      <SectionTitle>Preview · {preview.repo} @ {preview.commit.slice(0, 7)}</SectionTitle>
      <p className="mb-2 text-[13px] text-muted">
        Read the commit before you pin it:{" "}
        <ExternalLink to={preview.links.commit}>the commit on GitHub</ExternalLink>
        {commitLink(preview.links.compare) && (
          <>
            {" · "}
            <ExternalLink to={preview.links.compare}>what changed since the current pin</ExternalLink>
          </>
        )}
        . Agents get the new skills the next time they start.
      </p>
      <div className="mb-2 flex flex-col gap-1">
        <NameList label="Added" names={preview.added} />
        <NameList label="Changed" names={preview.changed} />
        <NameList label="Removed" names={preview.removed} />
      </div>
      {preview.rolesLosing.length > 0 && (
        <div className="mb-2 border-[3px] border-ink bg-cream p-2 text-[13px]">
          <b>Roles that lose a skill:</b>
          <ul className="m-0 list-disc pl-5">
            {preview.rolesLosing.map((r) => (
              <li key={r.role}>
                <b>{r.role}</b> loses <span className="font-term text-[14px]">{r.skills.join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {refused && (
        <div className="mb-2 border-[3px] border-red p-2 text-[13px]" role="alert">
          <b>HQ refuses this commit:</b>
          <ul className="m-0 list-disc pl-5">
            {preview.refused.map((r) => (
              <li key={`${r.skill}:${r.reason}`}>
                <span className="font-term text-[14px]">{r.skill}</span> ({r.reason})
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.findings.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1 text-[13px]">
          {preview.findings.map((f) => (
            <li key={f.name}>! {f.detail}</li>
          ))}
        </ul>
      )}
      <SkillsList lock={preview.skills} />
      <p className="mb-2 mt-2 break-all text-[12px] text-muted">
        Lock hash <span className="font-term text-[14px]">{preview.lockHash}</span>
      </p>
      {error && (
        <p className="mb-2 text-[13px] font-semibold text-red" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button className="btn text-[13px]" disabled={refused} onClick={() => onConfirm(preview.repo, preview.commit, preview.lockHash)} title="Pins exactly what is listed here (asks for your PIN)">
          Confirm with PIN
        </button>
        <button className="btn text-[13px]" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** Each skill with its short hash, file count and scripts. */
export function SkillsList({ lock }: { lock: { name: string; hash: string; files: number; scripts: string[] }[] }) {
  if (lock.length === 0) return <p className="text-[13px] text-muted">No skills.</p>;
  return (
    <div className="border-[3px] border-ink bg-white">
      {lock.map((s) => (
        <div key={s.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t-2 border-dashed border-cream-3 px-3 py-1.5 first:border-t-0">
          <b className="font-term text-[17px]">{s.name}</b>
          <span className="font-term text-[14px] text-muted" title="First 7 characters of the skill's hash">
            {s.hash.slice(0, 7)}
          </span>
          <span className="text-[12px] text-muted">{fileCount(s.files)}</span>
          {s.scripts.length > 0 && (
            <span className="text-[12px]">
              scripts:{" "}
              {s.scripts.map((p) => (
                <span key={p} className="chip mr-1 font-term text-[13px]">
                  {p}
                </span>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** One checkbox per role and pinned skill. A row is saved whole, with the PIN. */
export function RoleGrid({ skills, errors = {}, onSave }: { skills: SkillsState; /** A role's refused save, in HQ's words. */ errors?: Record<string, string>; onSave: (role: string, names: string[]) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const names = skills.lock.map((s) => s.name);
  return (
    <div className="flex flex-col gap-2">
      {Object.keys(skills.roles).map((role) => {
        const saved = skills.roles[role] ?? [];
        const current = drafts[role] ?? saved;
        const dirty = !sameSet(current, saved);
        // A name the role holds that is no longer pinned stays visible, so it can be removed.
        const stale = saved.filter((n) => !names.includes(n));
        return (
          <div key={role} className="border-[3px] border-ink bg-white px-3 py-2">
            <div className="mb-1 flex items-center gap-2">
              <b className="text-[15px]">{role}</b>
              <button className="btn ml-auto px-2 py-0 text-[12px]" disabled={!dirty} onClick={() => onSave(role, current)} title="Saves this role's skills (asks for your PIN)">
                Save
              </button>
            </div>
            {errors[role] && (
              <p className="mb-1 mt-0 text-[13px] font-semibold text-red" role="alert">
                {errors[role]}
              </p>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {[...names, ...stale].map((n) => (
                <label key={n} className="flex items-center gap-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    aria-label={`${role}: ${n}`}
                    checked={current.includes(n)}
                    onChange={(e) => setDrafts({ ...drafts, [role]: toggleName(current, n, e.target.checked) })}
                  />
                  <span className="font-term text-[15px]">{n}</span>
                  {stale.includes(n) && <span className="text-[12px] text-muted">not pinned</span>}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The agent's own skills: checkboxes of the pinned names. A granted name that is no longer pinned stays visible so it can be removed. */
export function SkillCheckboxes({ pinned, selected, onChange }: { pinned: string[]; selected: string[]; onChange: (names: string[]) => void }) {
  const stale = selected.filter((n) => !pinned.includes(n));
  return (
    <div className="flex flex-col gap-1">
      {pinned.length === 0 && <span className="text-[13px] text-muted">No skills are pinned yet. Pin a commit in Settings → Skills.</span>}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {[...pinned, ...stale].map((n) => (
          <label key={n} className="flex items-center gap-1.5 text-[13px]">
            <input type="checkbox" aria-label={n} checked={selected.includes(n)} onChange={(e) => onChange(toggleName(selected, n, e.target.checked))} />
            <span className="font-term text-[15px]">{n}</span>
            {stale.includes(n) && <span className="text-[12px] text-muted">not pinned</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

/** A stack tool's skills, each marked pinned or not. Only a pinned skill is installed. */
export function StackSkillStatus({ skills, pinned }: { skills: SkillSpec[]; pinned: ReadonlySet<string> }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-1 text-[12px]">
      {skills.flatMap((spec) =>
        spec.skills.map((name) => (
          <span key={`${spec.source}/${name}`} className="chip font-term text-[14px]" title={spec.source}>
            <span>{name}</span> {pinned.has(name) ? <span>pinned</span> : <span className="text-red">not pinned</span>}
          </span>
        )),
      )}
    </div>
  );
}

/** The skills repo's own settings check (SR-F-08), as HQ last found it. */
function RepoCheck({ guard }: { guard: SkillsGuardState }) {
  return (
    <div className="mt-2 text-[13px]">
      <p className="mb-1 text-muted">
        HQ checks {guard.repo} daily. Last checked {new Date(guard.checkedAt).toLocaleString()}.
      </p>
      {guard.findings.length === 0 ? (
        <p className="m-0 font-semibold">✓ The repo's settings are as they should be.</p>
      ) : (
        <ul className="m-0 flex flex-col gap-1">
          {guard.findings.map((f) => (
            <li key={f.name}>
              {f.fixable ? "✗" : "!"} {f.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The commit field and its Preview button. Preview stays off until the field holds exactly 40 hex characters. */
export function PinCommitForm({
  repo,
  commit,
  previewing,
  onChange,
  onPreview,
}: {
  repo: string;
  commit: string;
  previewing: boolean;
  onChange: (commit: string) => void;
  onPreview: (repo: string, commit: string) => void;
}) {
  const valid = isCommitSha(commit);
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !previewing) onPreview(repo, commit.trim().toLowerCase());
      }}
    >
      <input className="field flex-1 font-term text-[17px]" value={commit} onChange={(e) => onChange(e.target.value)} placeholder="commit, 40 hex characters" aria-label="Commit to pin" spellCheck={false} />
      <button className="btn" type="submit" disabled={!valid || previewing}>
        {previewing ? "Reading…" : "Preview"}
      </button>
    </form>
  );
}

export function SkillsSettings() {
  const skills = useOffice((s) => s.snap?.skills) ?? null;
  const guard = useOffice((s) => s.snap?.skillsGuard) ?? null;
  const flow = useOffice((s) => s.skillsPin);
  const roleErrors = useOffice((s) => s.skillsRoleErrors);
  return (
    <SkillsPanel
      skills={skills}
      guard={guard}
      flow={flow}
      roleErrors={roleErrors}
      onPreview={(repo, commit) => officeActions.previewSkillsPin(repo, commit)}
      onConfirm={(repo, commit, lockHash) => officeActions.pinSkills(repo, commit, lockHash)}
      onCancel={() => officeActions.resetSkillsPin()}
      onSaveRole={(role, names) => officeActions.setRoleSkills(role, names)}
    />
  );
}

export function SkillsPanel({
  skills,
  guard,
  flow,
  roleErrors,
  onPreview,
  onConfirm,
  onCancel,
  onSaveRole,
}: {
  skills: SkillsState | null;
  guard: SkillsGuardState | null;
  flow: SkillsPinFlow;
  roleErrors?: Record<string, string>;
  onPreview: (repo: string, commit: string) => void;
  onConfirm: (repo: string, commit: string, lockHash: string) => void;
  onCancel: () => void;
  onSaveRole: (role: string, names: string[]) => void;
}) {
  const [commit, setCommit] = useState("");
  const repo = skills?.source.repo ?? DEFAULT_SKILLS_REPO;
  const pinnedLink = skills ? commitLink(`https://github.com/${skills.source.repo}/commit/${skills.source.commit}`) : null;
  return (
    <div className="flex flex-col gap-5">
      <section className="border-[3px] border-ink bg-white p-3">
        <SectionTitle>Skills repo</SectionTitle>
        <p className="mb-1 text-[14px]">
          <span className="font-term text-[17px]">{repo}</span>
          {skills ? (
            <>
              {" "}
              pinned at <ExternalLink to={pinnedLink}>{skills.source.commit.slice(0, 7)}</ExternalLink>
            </>
          ) : (
            <span className="text-muted"> · nothing is pinned yet</span>
          )}
        </p>
        <p className="m-0 text-[13px] text-muted">
          Agents get only the skills pinned here, copied from HQ's own store at each start. Nothing is fetched while an agent runs.
        </p>
        {guard && <RepoCheck guard={guard} />}
      </section>

      <section>
        <SectionTitle>Pin a commit</SectionTitle>
        <p className="mb-2 text-[13px] text-muted">
          Paste a commit of {repo} that is on its default branch (40 characters). HQ reads it and shows what would change before anything is pinned.
        </p>
        <PinCommitForm repo={repo} commit={commit} previewing={flow.state === "previewing"} onChange={setCommit} onPreview={onPreview} />
        {flow.state === "failed" && (
          <p className="mt-2 text-[13px] font-semibold text-red" role="alert">
            {flow.message}
          </p>
        )}
      </section>

      {flow.state === "ready" && <PinPreviewView preview={flow.preview} error={flow.error} onConfirm={onConfirm} onCancel={onCancel} />}

      {skills && (
        <>
          <section>
            <SectionTitle>Pinned skills · {skills.lock.length}</SectionTitle>
            <SkillsList lock={skills.lock} />
          </section>
          <section>
            <SectionTitle>What each role gets</SectionTitle>
            <p className="mb-2 text-[13px] text-muted">An agent gets its role's skills, plus any you grant it under Settings → Team. Saving a role asks for your PIN and applies at each agent's next start.</p>
            <RoleGrid skills={skills} errors={roleErrors} onSave={onSaveRole} />
          </section>
        </>
      )}
    </div>
  );
}
