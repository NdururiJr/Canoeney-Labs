import { useState } from "react";
import { nextAgentName } from "../../data/names";
import { CLI_LABEL, type AgentCli, type AgentConfig, type AgentMode } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { agentPalette } from "../../theme/tokens";
import { Field, Portrait, SectionTitle } from "../kit";
import { CommitInput } from "./controls";
import { LocalModeNotice } from "./LocalModeNotice";
import { SkillCheckboxes } from "./SkillsSettings";
import { RemoveAgentDialog } from "./RemoveAgentDialog";

export function CliSelect({ value, onChange }: { value: AgentCli; onChange: (v: AgentCli) => void }) {
  return (
    <select className="field" value={value} onChange={(e) => onChange(e.target.value as AgentCli)} aria-label="Coding agent">
      {(Object.keys(CLI_LABEL) as AgentCli[]).map((c) => (
        <option key={c} value={c}>
          {CLI_LABEL[c]}
        </option>
      ))}
    </select>
  );
}
export const ROLE_SUGGESTIONS = ["Developer", "QA", "Designer", "Docs", "DevOps", "Security"];

export function TeamSettings() {
  const team = useOffice((s) => s.snap?.config.team);
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AgentConfig | null>(null);
  if (!team) return null;
  return (
    <div className="flex flex-col gap-5">
      <section>
        <SectionTitle>Team · {team.length} agents</SectionTitle>
        <p className="mb-3 text-[14px] text-muted">
          Changes to model, mode or folder apply the next time the agent starts. One lead plans and assigns work. Every other agent gets its own desk, sandbox and (optionally) environment. The office grows as you add agents.
        </p>
        <div className="flex flex-col gap-2">
          {team.map((a) => (
            <AgentRow key={a.id} agent={a} expanded={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} onRemove={() => setRemoving(a)} />
          ))}
        </div>
      </section>
      <AddAgent />
      {removing && <RemoveAgentDialog agent={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function AgentRow({ agent, expanded, onToggle, onRemove }: { agent: AgentConfig; expanded: boolean; onToggle: () => void; onRemove: () => void }) {
  const set = (patch: Parameters<typeof officeActions.updateAgent>[1]) => officeActions.updateAgent(agent.id, patch);
  const lock = useOffice((s) => s.snap?.skills?.lock);
  const pinned = (lock ?? []).map((k) => k.name);
  return (
    <div className="border-[3px] border-ink bg-white">
      <div className="grid grid-cols-[40px_1fr_1fr_150px_130px_auto] items-end gap-2.5 p-2.5">
        <Portrait color={agent.color} lead={agent.isLead} />
        <Field label="Name">
          <CommitInput className="field" value={agent.name} onCommit={(v) => v.trim() && set({ name: v.trim() })} />
        </Field>
        <Field label="Role">
          {agent.isLead ? (
            <div className="field flex h-9 items-center bg-cream-2">Lead</div>
          ) : (
            <CommitInput className="field" value={agent.role} list="role-suggestions" onCommit={(v) => v.trim() && set({ role: v.trim() })} />
          )}
        </Field>
        <Field label="Agent">
          <CliSelect value={agent.cli} onChange={(cli) => set({ cli })} />
        </Field>
        <Field label="Runs in">
          <select className="field" value={agent.mode} onChange={(e) => set({ mode: e.target.value as AgentMode })}>
            <option value="sandbox">Sandbox</option>
          </select>
        </Field>
        <div className="flex gap-1.5">
          <button className="btn px-2 text-[13px]" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? "Less" : "More"}
          </button>
          {!agent.isLead && (
            <button
              className="btn px-2 text-[13px] text-red"
              onClick={onRemove}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t-2 border-dashed border-cream-3 px-3 py-1 text-[12px] text-muted">
        {agent.github ? (
          <span>
            GitHub: works as <code>{agent.github.app}</code>. Install it on this project's repo only.
          </span>
        ) : (
          <>
            <span className="flex-1">No GitHub identity yet: this agent can't push or open pull requests.</span>
            <button className="btn px-2 text-[12px]" onClick={() => officeActions.createGithubIdentity(agent.id)} title="Creates this agent's own GitHub App on GitHub (asks for your PIN)">
              Create GitHub identity
            </button>
          </>
        )}
      </div>
      {agent.mode === "local" && <LocalModeNotice onSwitch={set} />}
      {expanded && (
        <div className="grid grid-cols-2 gap-3 border-t-[3px] border-ink bg-cream p-3">
          <Field label="Colour">
            <div className="flex flex-wrap gap-1.5">
              {agentPalette.map((c) => (
                <button
                  key={c}
                  className="h-6 w-6 border-[3px] border-ink"
                  style={{ background: c, outline: c === agent.color ? "3px solid #241a2e" : undefined, outlineOffset: 1 }}
                  aria-label={`Colour ${c}`}
                  onClick={() => set({ color: c })}
                />
              ))}
            </div>
          </Field>
          <Field label="Start with model" hint="Optional. Leave empty to use the CLI's default — you can always switch with /model in the terminal. Set it to keep a choice across restarts (e.g. Opus for the lead).">
            <CommitInput
              className="field"
              value={agent.model}
              placeholder={`${CLI_LABEL[agent.cli]} default`}
              list={agent.cli === "codex" ? "codex-models" : "claude-models"}
              onCommit={(v) => set({ model: v.trim() })}
            />
          </Field>
          {/* Not a Field: a <label> around checkboxes would toggle the first one when its text is clicked. */}
          <div className="flex flex-col gap-1" role="group" aria-label="Skills">
            <span className="text-[14px] font-semibold">Skills</span>
            <SkillCheckboxes pinned={pinned} selected={agent.skills} onChange={(skills) => set({ skills })} />
            <span className="text-[12px] text-muted">From the pinned set, on top of what the agent's role gets. Installed at the agent's next start.</span>
          </div>
          <div className="col-span-2">
            <Field label="Folder" hint="Leave empty and HQ keeps its own clone of the repo for this agent. Or enter an existing git folder.">
              <CommitInput
                className="field font-term text-[17px]"
                value={agent.workspacePath ?? ""}
                placeholder={`HQ-managed: ~/.jsmhq/…/${agent.id}`}
                onCommit={(v) => set({ workspacePath: v.trim() || null })}
              />
            </Field>
          </div>
          <div className="col-span-2">
            <Field label="ROLE.md" hint="Who this agent is. HQ adds the team, rules and tools, writes it to .jsmhq-role.md in the agent's folder (never committed) and loads it when the session starts. A ROLE.md the folder already has is included too, never overwritten.">
              <CommitInput multiline className="field h-[120px] resize-y font-term text-[17px] leading-tight" value={agent.roleMd} onCommit={(v) => set({ roleMd: v })} />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

function AddAgent() {
  const [name, setName] = useState("");
  const [role, setRole] = useState("Developer");
  const [cli, setCli] = useState<AgentCli>("claude");
  const [mode, setMode] = useState<AgentMode>("sandbox");
  const team = useOffice((s) => s.snap?.config.team) ?? [];
  const suggested = nextAgentName(team.map((a) => a.name));
  const add = () => {
    officeActions.addAgent({ name: name.trim() || suggested, role, cli, mode });
    setName("");
  };
  return (
    <section className="border-[3px] border-dashed border-ink p-3">
      <SectionTitle>Add an agent</SectionTitle>
      <form
        className="grid grid-cols-[1fr_1fr_150px_130px_auto] items-end gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Field label="Name">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested} />
        </Field>
        <Field label="Role">
          <input className="field" value={role} list="role-suggestions" onChange={(e) => setRole(e.target.value)} />
        </Field>
        <Field label="Agent">
          <CliSelect value={cli} onChange={setCli} />
        </Field>
        <Field label="Runs in">
          <select className="field" value={mode} onChange={(e) => setMode(e.target.value as AgentMode)}>
            <option value="sandbox">Sandbox</option>
          </select>
        </Field>
        <button className="btn" type="submit">
          Add
        </button>
      </form>
      <p className="mt-2 text-[12px] text-muted">
        HQ starts a new sandbox with the lead's network policy and allows it to reach HQ at host.docker.internal.
      </p>
      <datalist id="codex-models">
        <option value="gpt-5.6-sol" />
      </datalist>
      <datalist id="claude-models">
        <option value="opus" />
        <option value="sonnet" />
        <option value="haiku" />
      </datalist>
      <datalist id="role-suggestions">
        {ROLE_SUGGESTIONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </section>
  );
}
