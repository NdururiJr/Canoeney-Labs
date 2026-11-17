/** @jsxRuntime automatic */
// (tsx compiles this test outside tsconfig.json, which excludes tests: the pragma picks the same JSX runtime.)
// M0-F Task 7: Settings → Skills. The panel's view logic is props-driven, so it renders without a store.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SkillsPinPreview, SkillsState } from "../../data/types";
import {
  commitLink,
  DEFAULT_SKILLS_REPO,
  isCommitSha,
  PinCommitForm,
  PinPreviewView,
  RoleGrid,
  SkillsPanel,
  SkillCheckboxes,
  SkillsList,
  StackSkillStatus,
  toggleName,
} from "./SkillsSettings";

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);

const preview = (over: Partial<SkillsPinPreview> = {}): SkillsPinPreview => ({
  repo: "NdururiJr/canoeney-skills",
  commit: SHA,
  lockHash: "f".repeat(64),
  skills: [
    { name: "brainstorming", hash: "1".repeat(64), files: 3, scripts: [] },
    { name: "systematic-debugging", hash: "2".repeat(64), files: 9, scripts: ["find-polluter.sh", "scripts/run.py"] },
  ],
  refused: [],
  added: ["brainstorming"],
  changed: ["systematic-debugging"],
  removed: ["writing-plans"],
  rolesLosing: [{ role: "cto", skills: ["writing-plans"] }],
  findings: [],
  links: { commit: `https://github.com/NdururiJr/canoeney-skills/commit/${SHA}`, compare: `https://github.com/NdururiJr/canoeney-skills/compare/${OLD}...${SHA}` },
  ...over,
});

/** Every element in a rendered tree, to reach a click handler the way LocalModeNotice.test does. */
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node as ReactElement);
    walk((node as ReactElement<{ children?: ReactNode }>).props.children, out);
  }
  return out;
}
const textOf = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(textOf).join("") : typeof node === "string" || typeof node === "number" ? String(node) : node && typeof node === "object" && "props" in node ? textOf((node as ReactElement<{ children?: ReactNode }>).props.children) : "";

test("the preview lists the scripts and the roles that lose a skill", () => {
  const html = renderToStaticMarkup(<PinPreviewView preview={preview()} onConfirm={() => {}} onCancel={() => {}} />);
  assert.match(html, /find-polluter\.sh/);
  assert.match(html, /scripts\/run\.py/);
  assert.match(html, /cto/);
  assert.match(html, /writing-plans/);
  assert.match(html, /lose/i);
  // added, changed and removed are told apart, and the lock hash is shown.
  assert.match(html, /Added/);
  assert.match(html, /Changed/);
  assert.match(html, /Removed/);
  assert.match(html, new RegExp("f".repeat(64)));
});

test("the preview links the commit and the comparison", () => {
  const html = renderToStaticMarkup(<PinPreviewView preview={preview()} onConfirm={() => {}} onCancel={() => {}} />);
  assert.match(html, new RegExp(`<a [^>]*href="https://github.com/NdururiJr/canoeney-skills/commit/${SHA}"`));
  assert.match(html, new RegExp(`<a [^>]*href="https://github.com/NdururiJr/canoeney-skills/compare/${OLD}...${SHA}"`));
  assert.match(html, /rel="noreferrer noopener"/);
  assert.match(html, /target="_blank"/);
  // No pin yet: no comparison link, and a link that does not start with https://github.com/ is never rendered.
  const first = renderToStaticMarkup(
    <PinPreviewView preview={preview({ links: { commit: "javascript:alert(1)", compare: null } })} onConfirm={() => {}} onCancel={() => {}} />,
  );
  assert.doesNotMatch(first, /<a /);
  assert.doesNotMatch(first, /javascript:/);
  assert.equal(commitLink("https://evil.example/x"), null);
  assert.equal(commitLink("https://github.com/a/b/commit/c"), "https://github.com/a/b/commit/c");
});

test("SR-C text from the repo is shown as plain text, never as markup", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const html = renderToStaticMarkup(
    <PinPreviewView
      preview={preview({
        skills: [{ name: evil, hash: "1".repeat(64), files: 1, scripts: [evil] }],
        added: [evil],
        findings: [{ name: "x", detail: evil, fixable: false }],
      })}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("Confirm sends the previewed lock hash", () => {
  const sent: unknown[][] = [];
  const p = preview();
  const el = PinPreviewView({ preview: p, onConfirm: (...a: unknown[]) => sent.push(a), onCancel: () => {} }) as ReactElement;
  const confirm = walk(el).find((e) => e.type === "button" && /Confirm/.test(textOf(e)));
  assert.ok(confirm, "a Confirm button");
  (confirm.props as { onClick: () => void }).onClick();
  assert.deepEqual(sent, [[p.repo, p.commit, p.lockHash]]);
});

test("a preview with a refused skill cannot be confirmed, and says why", () => {
  const html = renderToStaticMarkup(
    <PinPreviewView preview={preview({ refused: [{ skill: "bad-skill", reason: "link" }] })} onConfirm={() => {}} onCancel={() => {}} />,
  );
  assert.match(html, /bad-skill/);
  assert.match(html, /<button[^>]*disabled[^>]*>Confirm/);
});

test("a failed confirm shows HQ's reason next to the preview", () => {
  const html = renderToStaticMarkup(<PinPreviewView preview={preview()} error="This commit no longer reads the way it did." onConfirm={() => {}} onCancel={() => {}} />);
  assert.match(html, /no longer reads the way it did/);
});

test("a stack skill that is not pinned says so", () => {
  const html = renderToStaticMarkup(
    <StackSkillStatus skills={[{ source: "vercel-labs/agent-skills", skills: ["vercel-react-best-practices", "brainstorming"] }]} pinned={new Set(["brainstorming"])} />,
  );
  assert.match(html, /vercel-react-best-practices[^<]*<\/span>[^]*not pinned/);
  assert.match(html, /brainstorming[^<]*<\/span>[^]*pinned/);
  const none = renderToStaticMarkup(<StackSkillStatus skills={[{ source: "a/b", skills: ["x"] }]} pinned={new Set()} />);
  assert.match(none, /not pinned/);
  const all = renderToStaticMarkup(<StackSkillStatus skills={[{ source: "a/b", skills: ["x"] }]} pinned={new Set(["x"])} />);
  assert.doesNotMatch(all, /not pinned/);
});

const state: SkillsState = {
  source: { repo: "NdururiJr/canoeney-skills", commit: SHA, lockHash: "f".repeat(64) },
  lock: [
    { name: "brainstorming", hash: "1234567".padEnd(64, "0"), files: 3, scripts: [] },
    { name: "systematic-debugging", hash: "abcdef0".padEnd(64, "0"), files: 9, scripts: ["find-polluter.sh"] },
  ],
  roles: { builder: ["systematic-debugging"], cto: ["brainstorming"], ceo: [] },
};

test("the skills list shows each skill's short hash, file count and scripts", () => {
  const html = renderToStaticMarkup(<SkillsList lock={state.lock} />);
  assert.match(html, /brainstorming/);
  assert.match(html, /1234567/);
  assert.doesNotMatch(html, /1234567\d{5}/);
  assert.match(html, /9 files/);
  assert.match(html, /find-polluter\.sh/);
});

test("the role grid has one checkbox per role and pinned skill, and saves a row's whole set", () => {
  const html = renderToStaticMarkup(<RoleGrid skills={state} onSave={() => {}} />);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3 * 2);
  assert.match(html, /<input[^>]*checked=""[^>]*aria-label="builder: systematic-debugging"|<input[^>]*aria-label="builder: systematic-debugging"[^>]*checked=""/);
  assert.deepEqual(toggleName(["a", "c"], "b", true), ["a", "b", "c"]);
  assert.deepEqual(toggleName(["a", "b"], "a", false), ["b"]);
  assert.deepEqual(toggleName(["a"], "a", true), ["a"]);
});

test("the agent's skills are checkboxes of the pinned names", () => {
  const sent: string[][] = [];
  const html = renderToStaticMarkup(<SkillCheckboxes pinned={["brainstorming", "writing-plans"]} selected={["writing-plans", "old-skill"]} onChange={(n) => sent.push(n)} />);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  // a granted name that is no longer pinned stays visible, flagged, so it can be unchecked
  assert.match(html, /old-skill/);
  assert.match(html, /not pinned/);
  const el = SkillCheckboxes({ pinned: ["brainstorming", "writing-plans"], selected: ["writing-plans"], onChange: (n) => sent.push(n) }) as ReactElement;
  const box = walk(el).find((e) => e.type === "input" && (e.props as { "aria-label"?: string })["aria-label"] === "brainstorming");
  (box?.props as { onChange: (e: { target: { checked: boolean } }) => void }).onChange({ target: { checked: true } });
  assert.deepEqual(sent, [["brainstorming", "writing-plans"]]);
  assert.match(renderToStaticMarkup(<SkillCheckboxes pinned={[]} selected={[]} onChange={() => {}} />), /No skills are pinned/);
});

test("a commit is exactly 40 hex characters, and the repo defaults to the company's", () => {
  assert.equal(isCommitSha(SHA), true);
  assert.equal(isCommitSha(` ${SHA} `), true);
  assert.equal(isCommitSha("a".repeat(39)), false);
  assert.equal(isCommitSha("a".repeat(41)), false);
  assert.equal(isCommitSha("g".repeat(40)), false);
  assert.equal(DEFAULT_SKILLS_REPO, "NdururiJr/canoeney-skills");
});

test("Preview is disabled until the field holds exactly 40 hex characters, and sends the repo and the lower-case commit", () => {
  const form = (commit: string, previewing = false) => renderToStaticMarkup(<PinCommitForm repo="a/b" commit={commit} previewing={previewing} onChange={() => {}} onPreview={() => {}} />);
  assert.match(form(""), /<button[^>]*disabled[^>]*>Preview/);
  assert.match(form("a".repeat(39)), /<button[^>]*disabled[^>]*>Preview/);
  assert.match(form("a".repeat(41)), /<button[^>]*disabled[^>]*>Preview/);
  assert.match(form("z".repeat(40)), /<button[^>]*disabled[^>]*>Preview/);
  assert.doesNotMatch(form("a".repeat(40)), /disabled/);
  assert.match(form("a".repeat(40), true), /<button[^>]*disabled[^>]*>Reading/);

  const sent: unknown[][] = [];
  const submit = (commit: string, previewing = false) => {
    const el = PinCommitForm({ repo: "a/b", commit, previewing, onChange: () => {}, onPreview: (...a: unknown[]) => sent.push(a) }) as ReactElement;
    (el.props as { onSubmit: (e: { preventDefault(): void }) => void }).onSubmit({ preventDefault() {} });
  };
  submit("A".repeat(40));
  submit("a".repeat(39));
  submit("a".repeat(40), true);
  assert.deepEqual(sent, [["a/b", "a".repeat(40)]]);
});

const panelProps = { skills: null, guard: null, onPreview: () => {}, onConfirm: () => {}, onCancel: () => {}, onSaveRole: () => {} };

test("the panel shows a failed preview's message, and the preview with a failed confirm's reason", () => {
  const failed = renderToStaticMarkup(<SkillsPanel {...panelProps} flow={{ state: "failed", message: "That commit is not on the default branch." }} />);
  assert.match(failed, /role="alert"[^>]*>That commit is not on the default branch\./);
  assert.match(failed, /disabled/, "Preview is off while the field is empty");
  assert.match(failed, /NdururiJr\/canoeney-skills/, "the repo defaults to the company's");
  const ready = renderToStaticMarkup(<SkillsPanel {...panelProps} flow={{ state: "ready", preview: preview(), error: "HQ would not pin it." }} />);
  assert.match(ready, /Confirm with PIN/);
  assert.match(ready, /HQ would not pin it\./);
  const idle = renderToStaticMarkup(<SkillsPanel {...panelProps} flow={{ state: "idle" }} />);
  assert.doesNotMatch(idle, /role="alert"/);
});

test("a refused role save is shown on its own row", () => {
  const html = renderToStaticMarkup(<RoleGrid skills={state} errors={{ cto: "x is not a skill name." }} onSave={() => {}} />);
  assert.match(html, /role="alert"[^>]*>x is not a skill name\./);
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
  const panel = renderToStaticMarkup(<SkillsPanel {...panelProps} skills={state} flow={{ state: "idle" }} roleErrors={{ builder: "HQ did not save this role." }} />);
  assert.match(panel, /HQ did not save this role\./);
});
