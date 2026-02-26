import assert from "node:assert/strict";
import test from "node:test";
import { fetchWorkflowYaml, resolveRawWorkflowUrl, sanitizeWorkflowUrl } from "./workflow-import.js";

test("resolveRawWorkflowUrl converts github blob url to raw url", () => {
  const rawUrl = resolveRawWorkflowUrl("https://github.com/actions/checkout/blob/main/.github/workflows/test.yml");
  assert.equal(rawUrl, "https://raw.githubusercontent.com/actions/checkout/main/.github/workflows/test.yml");
});

test("resolveRawWorkflowUrl rejects unsupported host", () => {
  assert.throws(() => resolveRawWorkflowUrl("https://example.com/workflow.yml"), /invalid_workflow_host/);
});

test("sanitizeWorkflowUrl rejects blank input", () => {
  assert.throws(() => sanitizeWorkflowUrl({ workflowUrl: "   " }), /invalid_workflow_url/);
});

test("fetchWorkflowYaml returns yaml text", async () => {
  const yaml = await fetchWorkflowYaml(
    "https://raw.githubusercontent.com/actions/checkout/main/.github/workflows/test.yml",
    async () => new Response("name: CI\non: [push]\n")
  );
  assert.ok(yaml.includes("name:"));
});

test("fetchWorkflowYaml maps failed responses to workflow_fetch_failed", async () => {
  await assert.rejects(
    () => fetchWorkflowYaml("https://raw.githubusercontent.com/actions/checkout/main/.github/workflows/test.yml", async () => new Response("nope", { status: 404 })),
    /workflow_fetch_failed/
  );
});
