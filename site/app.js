const estimateForm = document.getElementById("estimate-form");
const resultSection = document.getElementById("result");
const recommendationEl = document.getElementById("recommendation");
const summaryEl = document.getElementById("summary");
const policySnippetEl = document.getElementById("policy-snippet");
const checkoutBtn = document.getElementById("checkout-btn");
const submitBtn = document.getElementById("submit-btn");
const sampleEstimateBtn = document.getElementById("sample-estimate-btn");
const workflowUrlInput = document.getElementById("workflow-url");
const importBtn = document.getElementById("import-btn");
const importStatusEl = document.getElementById("import-status");
const workflowYamlInput = document.getElementById("workflow-yaml");
const monthlyRunsInput = document.getElementById("monthly-runs");
const budgetUsdInput = document.getElementById("budget-usd");
const policyModeInput = document.getElementById("policy-mode");

const DEFAULT_WORKFLOW_YAML = [
  "name: CI",
  "on: [push, pull_request]",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: npm ci",
  "      - run: npm test",
  "  lint:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: npm run lint"
].join("\n");
const WORKFLOW_STORAGE_KEY = "actions-cost-guard.workflow_yaml";
const AUTO_PREVIEW_STORAGE_KEY = "actions-cost-guard.auto_preview_v1";

let activeSessionId = null;
let activePaymentUrl = null;
const activeSource = resolveSource();

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "request_failed");
  }
  return data;
}

function normalizeSource(rawSource) {
  if (typeof rawSource !== "string") {
    return "web";
  }
  const normalized = rawSource.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(normalized)) {
    return "web";
  }
  return normalized;
}

function resolveSource() {
  const params = new URLSearchParams(window.location.search);
  return normalizeSource(params.get("utm_source") || params.get("source") || params.get("ref") || "web");
}

function initializeWorkflowYaml() {
  let savedWorkflow = "";
  try {
    savedWorkflow = window.localStorage.getItem(WORKFLOW_STORAGE_KEY) || "";
  } catch {
    savedWorkflow = "";
  }
  workflowYamlInput.value = savedWorkflow.trim() ? savedWorkflow : DEFAULT_WORKFLOW_YAML;
}

function persistWorkflowYaml(workflowYaml) {
  try {
    window.localStorage.setItem(WORKFLOW_STORAGE_KEY, workflowYaml);
  } catch {
    // Ignore browsers where localStorage is blocked.
  }
}

function hasCompletedAutoPreview() {
  try {
    return Boolean(window.localStorage.getItem(AUTO_PREVIEW_STORAGE_KEY));
  } catch {
    return false;
  }
}

function markAutoPreviewCompleted() {
  try {
    window.localStorage.setItem(AUTO_PREVIEW_STORAGE_KEY, new Date().toISOString());
  } catch {
    // Ignore browsers where localStorage is blocked.
  }
}

function setImportStatus(message, isError = false) {
  importStatusEl.textContent = message;
  importStatusEl.classList.toggle("error", isError);
}

function formatImportError(errorCode) {
  if (errorCode === "invalid_workflow_url") {
    return "Enter a valid HTTPS GitHub workflow URL.";
  }
  if (errorCode === "invalid_workflow_host") {
    return "Use github.com or raw.githubusercontent.com workflow links.";
  }
  if (errorCode === "invalid_workflow_path") {
    return "URL must point to a .yml or .yaml workflow file.";
  }
  if (errorCode === "workflow_fetch_timeout") {
    return "GitHub fetch timed out. Try again in a few seconds.";
  }
  if (errorCode === "workflow_fetch_failed") {
    return "Could not fetch workflow YAML. Check the URL and repository visibility.";
  }
  if (errorCode === "workflow_too_large") {
    return "Workflow file is too large to import.";
  }
  if (errorCode === "workflow_empty") {
    return "Workflow file appears empty.";
  }
  return `Import failed: ${errorCode}`;
}

function buildEstimateRequest(workflowYamlOverride = null) {
  return {
    workflowYaml: (workflowYamlOverride || workflowYamlInput.value).trim() || DEFAULT_WORKFLOW_YAML,
    monthlyRuns: Number(monthlyRunsInput.value),
    budgetUsd: Number(budgetUsdInput.value),
    policyMode: policyModeInput.value,
    source: activeSource,
    selfTest: false
  };
}

function buildPolicySnippet(estimate) {
  return [
    "# PR cost policy",
    `monthly_runs: ${estimate.summary.monthlyRuns}`,
    `estimated_monthly_usd: ${estimate.summary.monthlyCostUsd.toFixed(2)}`,
    `budget_usd: ${estimate.summary.budgetUsd.toFixed(2)}`,
    `mode: ${estimate.summary.policyMode}`,
    `decision: ${estimate.summary.policyDecision}`,
    "",
    estimate.summary.policyDecision === "pass"
      ? "Result: workflow can merge under current budget policy."
      : estimate.summary.policyDecision === "warn"
        ? "Result: warning should be posted and owner approval required."
        : "Result: merge should be blocked until estimated cost drops."
  ].join("\n");
}

function renderEstimate(payload) {
  const { estimate, recommendation } = payload;
  recommendationEl.textContent = recommendation;

  summaryEl.innerHTML = "";
  const lines = [
    `jobs: ${estimate.summary.jobs}`,
    `steps: ${estimate.summary.stepCount}`,
    `minutes/run: ${estimate.summary.minutesPerRun.toFixed(2)}`,
    `cost/run: $${estimate.summary.costPerRunUsd.toFixed(2)}`,
    `monthly runs: ${estimate.summary.monthlyRuns}`,
    `monthly cost: $${estimate.summary.monthlyCostUsd.toFixed(2)}`,
    `budget: $${estimate.summary.budgetUsd.toFixed(2)}`,
    `policy: ${estimate.summary.policyDecision.toUpperCase()}`
  ];

  for (const line of lines) {
    const item = document.createElement("div");
    item.textContent = line;
    summaryEl.appendChild(item);
  }

  policySnippetEl.textContent = buildPolicySnippet(estimate);
  resultSection.hidden = false;
}

function setBusyState(isBusy) {
  submitBtn.disabled = isBusy;
  importBtn.disabled = isBusy;
  if (sampleEstimateBtn) {
    sampleEstimateBtn.disabled = isBusy;
  }
}

async function generateEstimate({
  workflowYamlOverride = null,
  estimateIntent = "manual_submit"
} = {}) {
  const payload = await postJson("/api/estimate", {
    ...buildEstimateRequest(workflowYamlOverride),
    estimateIntent
  });
  activeSessionId = payload.sessionId;
  activePaymentUrl = payload.checkout?.paymentUrl || null;
  renderEstimate(payload);
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function shouldRunAutoPreview() {
  const params = new URLSearchParams(window.location.search);
  const preview = (params.get("preview") || "").trim().toLowerCase();
  if (preview === "off" || preview === "0") {
    return false;
  }
  return !hasCompletedAutoPreview();
}

async function runAutoPreview() {
  setBusyState(true);
  setImportStatus("Generating instant sample preview...");
  try {
    await generateEstimate({
      workflowYamlOverride: workflowYamlInput.value.trim() || DEFAULT_WORKFLOW_YAML,
      estimateIntent: "auto_preview"
    });
    setImportStatus("Instant sample preview ready. Import your own workflow URL to compare.");
    markAutoPreviewCompleted();
  } catch (error) {
    setImportStatus(`Instant preview failed: ${error.message}`, true);
  } finally {
    setBusyState(false);
  }
}

initializeWorkflowYaml();
setImportStatus("Supports github.com/blob and raw.githubusercontent.com links.");

workflowYamlInput.addEventListener("input", () => {
  persistWorkflowYaml(workflowYamlInput.value);
});

estimateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusyState(true);

  try {
    await generateEstimate({ estimateIntent: "manual_submit" });
  } catch (error) {
    recommendationEl.textContent = `Could not generate estimate: ${error.message}`;
    resultSection.hidden = false;
  } finally {
    setBusyState(false);
  }
});

importBtn.addEventListener("click", async () => {
  const workflowUrl = workflowUrlInput.value.trim();
  if (!workflowUrl) {
    setImportStatus("Enter a workflow URL before import.", true);
    workflowUrlInput.focus();
    return;
  }

  setBusyState(true);
  setImportStatus("Importing workflow from GitHub...");

  try {
    const imported = await postJson("/api/workflow/import", { workflowUrl });
    const importedYaml = imported.workflowYaml || "";
    workflowYamlInput.value = importedYaml;
    persistWorkflowYaml(importedYaml);
    setImportStatus("Workflow imported. Generating estimate...");
    await generateEstimate({
      workflowYamlOverride: importedYaml,
      estimateIntent: "import_url"
    });
    setImportStatus("Imported and estimated. Review the result below.");
  } catch (error) {
    setImportStatus(formatImportError(error.message), true);
  } finally {
    setBusyState(false);
  }
});

if (sampleEstimateBtn) {
  sampleEstimateBtn.addEventListener("click", async () => {
    setBusyState(true);
    workflowYamlInput.value = DEFAULT_WORKFLOW_YAML;
    persistWorkflowYaml(DEFAULT_WORKFLOW_YAML);
    setImportStatus("Using sample workflow. Generating estimate...");
    try {
      await generateEstimate({
        workflowYamlOverride: DEFAULT_WORKFLOW_YAML,
        estimateIntent: "sample_cta"
      });
      setImportStatus("Sample estimate ready. Edit YAML or import yours next.");
    } catch (error) {
      setImportStatus(`Sample estimate failed: ${error.message}`, true);
      recommendationEl.textContent = `Could not generate estimate: ${error.message}`;
      resultSection.hidden = false;
    } finally {
      setBusyState(false);
    }
  });
}

checkoutBtn.addEventListener("click", async () => {
  if (!activeSessionId) {
    recommendationEl.textContent = "Generate an estimate before checkout.";
    return;
  }

  checkoutBtn.disabled = true;
  try {
    const payload = await postJson("/api/billing/checkout", {
      sessionId: activeSessionId,
      source: activeSource,
      selfTest: false
    });

    const url = payload.paymentUrl || activePaymentUrl;
    if (!url) {
      throw new Error("missing_payment_url");
    }
    window.location.assign(url);
  } catch (error) {
    recommendationEl.textContent = `Checkout could not start: ${error.message}`;
  } finally {
    checkoutBtn.disabled = false;
  }
});

if (shouldRunAutoPreview()) {
  window.setTimeout(() => {
    void runAutoPreview();
  }, 400);
}

postJson("/api/events/landing-view", {
  source: activeSource,
  selfTest: false,
  userAgent: navigator.userAgent
}).catch(() => undefined);
