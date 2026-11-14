/** @jsxRuntime automatic */
// (tsx compiles this test outside tsconfig.json, which excludes tests: the pragma picks the same JSX runtime.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AddProjectDialogView } from "./AddProjectDialog";

test("add project shows progress until the reply", () => {
  const adding = renderToStaticMarkup(<AddProjectDialogView status={{ state: "adding" }} onAdd={() => {}} onClose={() => {}} />);
  assert.match(adding, /Adding/);
  assert.match(adding, /<button[^>]*disabled=""[^>]*>Add project<\/button>/);
  const failed = renderToStaticMarkup(<AddProjectDialogView status={{ state: "failed", message: "This folder is not a git repository." }} onAdd={() => {}} onClose={() => {}} />);
  assert.match(failed, /This folder is not a git repository\./);
});
