/** @jsxRuntime automatic */
// (tsx compiles this test outside tsconfig.json, which excludes tests: the pragma picks the same JSX runtime.)
// PR #12 review: drift the owner has not seen (GitHub protection, the skills repo) shows on the top bar.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GithubGuardState, SkillsGuardState } from "../../data/types";
import { guardTab, SettingsButton } from "./SettingsButton";

const finding = { name: "repo-secrets", detail: "The repo has a secret.", fixable: false };
const github = (findings: GithubGuardState["findings"]): GithubGuardState => ({ repo: "acme/site", checkedAt: "2026-11-15T10:00:00.000Z", findings, private: false });
const skills = (findings: SkillsGuardState["findings"]): SkillsGuardState => ({ repo: "acme/skills", checkedAt: "2026-11-15T10:00:00.000Z", findings });

const mark = (snap: Parameters<typeof guardTab>[0]) => /aria-label="Needs your attention/.test(renderToStaticMarkup(<SettingsButton snap={snap} onOpen={() => {}} />));

test("the Settings button shows a mark while a guard has findings", () => {
  assert.equal(mark({}), false, "no check yet");
  assert.equal(mark({ githubGuard: github([]), skillsGuard: skills([]) }), false, "both clean");
  assert.equal(mark({ githubGuard: github([]), skillsGuard: null }), false, "no skills repo pinned");
  assert.equal(mark({ githubGuard: github([finding]) }), true, "the GitHub guard has a finding");
  assert.equal(mark({ skillsGuard: skills([finding]) }), true, "the skills repo check has a finding");
  assert.equal(mark({ githubGuard: github([finding]), skillsGuard: skills([finding]) }), true);
  // It is still the Settings button.
  assert.match(renderToStaticMarkup(<SettingsButton snap={{}} onOpen={() => {}} />), /<button[^>]*>Settings<\/button>/);
});

test("the Settings button opens the tab that holds the finding", () => {
  const opened: string[] = [];
  const click = (snap: Parameters<typeof guardTab>[0]) => {
    const el = SettingsButton({ snap, onOpen: (tab) => opened.push(tab) }) as { props: { onClick: () => void } };
    el.props.onClick();
  };
  click({});
  click({ githubGuard: github([finding]) });
  click({ skillsGuard: skills([finding]) });
  click({ githubGuard: github([finding]), skillsGuard: skills([finding]) });
  assert.deepEqual(opened, ["team", "project", "skills", "project"]);
});
