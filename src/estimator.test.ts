import test from "node:test";
import assert from "node:assert/strict";
import { estimateWorkflowCost, sanitizeEstimateInput } from "./estimator.js";

test("estimateWorkflowCost computes monthly policy decision", () => {
  const workflowYaml = `
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
  windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;

  const input = sanitizeEstimateInput({
    workflowYaml,
    monthlyRuns: 500,
    budgetUsd: 40,
    policyMode: "block"
  });

  const result = estimateWorkflowCost(input);

  assert.equal(result.summary.jobs, 2);
  assert.equal(result.summary.policyDecision, "block");
  assert.ok(result.summary.monthlyCostUsd > 40);
  assert.equal(result.byOs.length, 2);
});

test("sanitizeEstimateInput rejects invalid values", () => {
  assert.throws(
    () =>
      sanitizeEstimateInput({
        workflowYaml: "",
        monthlyRuns: 200,
        budgetUsd: 20,
        policyMode: "warn"
      }),
    /invalid_workflow_yaml/
  );

  assert.throws(
    () =>
      sanitizeEstimateInput({
        workflowYaml: "jobs:\n  a:\n    runs-on: ubuntu-latest",
        monthlyRuns: -1,
        budgetUsd: 20,
        policyMode: "warn"
      }),
    /invalid_monthly_runs/
  );

  assert.throws(
    () =>
      sanitizeEstimateInput({
        workflowYaml: "jobs:\n  a:\n    runs-on: ubuntu-latest",
        monthlyRuns: 100,
        budgetUsd: 20,
        policyMode: "noop"
      }),
    /invalid_policy_mode/
  );
});
