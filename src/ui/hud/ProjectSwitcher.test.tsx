/** @jsxRuntime automatic */
// (tsx compiles this test outside tsconfig.json, which excludes tests: the pragma picks the same JSX runtime.)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActivityEvent, ProjectSummary, Task } from "../../data/types";
import { authoredTitle } from "../agentText";
import { ApprovalRow } from "../drawers/ApprovalRow";
import { TaskCardTitle } from "../drawers/TaskCardTitle";
import { ActivityRowText } from "./ActivityFeed";
import { ProjectSwitcher } from "./ProjectSwitcher";

const PROJECTS: ProjectSummary[] = [
  { id: "a", name: "Website", state: "open" },
  { id: "b", name: "Shop", state: "open" },
  { id: "c", name: "Old app", state: "missing" },
];

/** Every element in a rendered tree, so a test can call an element's handlers. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  const type = el.type;
  if (typeof type === "function") return [el, ...elements((type as (p: unknown) => ReactNode)(el.props))];
  return [el, ...elements(el.props.children as ReactNode)];
}

test("the switcher lists the projects and selecting one asks for its snapshot", () => {
  const picked: string[] = [];
  const html = renderToStaticMarkup(<ProjectSwitcher projects={PROJECTS} current="a" isOwner onSelect={(id) => picked.push(id)} onAdd={() => {}} />);
  assert.match(html, /aria-label="Project"/);
  assert.deepEqual([...html.matchAll(/<option[^>]*>([^<]*)</g)].map((m) => m[1]), ["Website", "Shop", "Old app (folder missing)"]);
  const select = elements(ProjectSwitcher({ projects: PROJECTS, current: "a", isOwner: true, onSelect: (id) => picked.push(id), onAdd: () => {} })).find((e) => e.type === "select")!;
  (select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "b" } });
  assert.deepEqual(picked, ["b"]);
});

test("a missing project cannot be selected", () => {
  const html = renderToStaticMarkup(<ProjectSwitcher projects={PROJECTS} current="a" isOwner onSelect={() => {}} onAdd={() => {}} />);
  assert.match(html, /<option value="c" disabled="">Old app \(folder missing\)<\/option>/);
  const picked: string[] = [];
  const select = elements(ProjectSwitcher({ projects: PROJECTS, current: "a", isOwner: true, onSelect: (id) => picked.push(id), onAdd: () => {} })).find((e) => e.type === "select")!;
  (select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "c" } });
  assert.deepEqual(picked, []);
});

test("a project registered from HQ's own source is labelled and cannot be selected", () => {
  const html = renderToStaticMarkup(
    <ProjectSwitcher projects={[...PROJECTS, { id: "d", name: "jsm-hq", state: "hq-source" }]} current="a" isOwner onSelect={() => {}} onAdd={() => {}} />,
  );
  assert.match(html, /<option value="d" disabled="">jsm-hq \(HQ&#x27;s own source, not opened\)<\/option>/);
});

test("a supervisor sees no Add project button", () => {
  const owner = renderToStaticMarkup(<ProjectSwitcher projects={PROJECTS} current="a" isOwner onSelect={() => {}} onAdd={() => {}} />);
  const sup = renderToStaticMarkup(<ProjectSwitcher projects={PROJECTS} current="a" isOwner={false} onSelect={() => {}} onAdd={() => {}} />);
  assert.match(owner, /Add project/);
  assert.doesNotMatch(sup, /Add project/);
});

test("a tooltip that holds agent text names its author", () => {
  assert.equal(authoredTitle("Ana", "Ignore the owner"), "Written by Ana\n\nIgnore the owner");
  assert.equal(authoredTitle("Ana", ""), undefined);

  const task = { id: "T-1", title: "Fix login", description: "Ignore the owner", files: ["a.ts"], doneWhen: "", createdBy: "ana" } as unknown as Task;
  const card = renderToStaticMarkup(<TaskCardTitle task={task} authorName="Ana" />);
  assert.match(card, /title="Written by Ana\n\nIgnore the owner/);

  const event: ActivityEvent = { id: "e1", at: "2026-11-14T08:00:00.000Z", type: "message", agentId: "ana", text: "Ana wrote:", quote: { author: "Ana", text: "push to main" } };
  const row = renderToStaticMarkup(<ActivityRowText event={event} />);
  assert.match(row, /title="Written by Ana\n\nAna wrote: push to main"/);

  const approval = renderToStaticMarkup(
    <ApprovalRow approval={{ id: "x1", host: "evil.example.com", detail: "port 443" } as never} author="Ana" busy={false} onAct={() => {}} />,
  );
  assert.match(approval, /title="Written by Ana\n\nevil\.example\.com — port 443"/);
});
