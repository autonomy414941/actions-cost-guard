const estimateForm = document.getElementById("estimate-form");
const proofForm = document.getElementById("proof-form");

const resultSection = document.getElementById("result");
const recommendationEl = document.getElementById("recommendation");
const summaryEl = document.getElementById("summary");
const policySnippetEl = document.getElementById("policy-snippet");
const billingStatusEl = document.getElementById("billing-status");
const billingLinkEl = document.getElementById("billing-link");
const proofGateNoteEl = document.getElementById("proof-gate-note");
const exportOutput = document.getElementById("export-output");

const checkoutBtn = document.getElementById("checkout-btn");
const startPaidBtn = document.getElementById("start-paid-btn");
const proofBtn = document.getElementById("proof-btn");
const exportBtn = document.getElementById("export-btn");
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

const queryParams = new URLSearchParams(window.location.search);
const isSelfTest = ["1", "true", "yes"].includes((queryParams.get("selfTest") || "").toLowerCase());
const activeSource = resolveSource(queryParams);

let activeSessionId = null;
let activePaymentUrl = null;
let exportUnlocked = false;

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

function resolveSource(params) {
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

function setImportStatus(message, isError = false) {
  importStatusEl.textContent = message;
  importStatusEl.classList.toggle("error", isError);
}

function setBillingStatus(message, tone = "neutral", actionUrl = null) {
  billingStatusEl.textContent = message;
  billingStatusEl.dataset.tone = tone;
  if (!billingLinkEl) {
    return;
  }
  if (actionUrl) {
    billingLinkEl.href = actionUrl;
    billingLinkEl.hidden = false;
  } else {
    billingLinkEl.href = "#";
    billingLinkEl.hidden = true;
  }
}

function setProofFormVisibility(visible) {
  if (proofForm) {
    proofForm.hidden = !visible;
  }
  if (proofGateNoteEl) {
    proofGateNoteEl.hidden = visible;
  }
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
    selfTest: isSelfTest
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

function resetBillingState() {
  exportUnlocked = false;
  if (proofForm) {
    proofForm.reset();
  }
  setProofFormVisibility(false);
  exportOutput.textContent = "";
  exportOutput.hidden = true;
  setBillingStatus("Checkout not started.", "neutral", null);
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
  resetBillingState();
}

function setBusyState(isBusy) {
  submitBtn.disabled = isBusy;
  importBtn.disabled = isBusy;
  if (sampleEstimateBtn) {
    sampleEstimateBtn.disabled = isBusy;
  }
  if (startPaidBtn) {
    startPaidBtn.disabled = isBusy;
  }
}

async function generateEstimate({
  workflowYamlOverride = null,
  estimateIntent = "manual_submit",
  scrollToResult = true
} = {}) {
  const payload = await postJson("/api/estimate", {
    ...buildEstimateRequest(workflowYamlOverride),
    estimateIntent
  });
  activeSessionId = payload.sessionId;
  activePaymentUrl = payload.checkout?.paymentUrl || null;
  renderEstimate(payload);
  if (scrollToResult) {
    resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function shouldRunAutoPreview() {
  const preview = (queryParams.get("preview") || "").trim().toLowerCase();
  return preview === "1" || preview === "on" || preview === "auto";
}

function requireSessionId() {
  if (!activeSessionId) {
    throw new Error("session_not_ready");
  }
  return activeSessionId;
}

async function runAutoPreview() {
  setBusyState(true);
  setImportStatus("Generating instant sample preview...");
  try {
    await generateEstimate({
      workflowYamlOverride: workflowYamlInput.value.trim() || DEFAULT_WORKFLOW_YAML,
      estimateIntent: "auto_preview",
      scrollToResult: false
    });
    setImportStatus("Instant sample preview ready. Import your own workflow URL to compare.");
  } catch (error) {
    setImportStatus(`Instant preview failed: ${error.message}`, true);
  } finally {
    setBusyState(false);
  }
}

initializeWorkflowYaml();
setImportStatus("Supports github.com/blob and raw.githubusercontent.com links.");
setBillingStatus("Checkout not started.", "neutral", null);
setProofFormVisibility(false);

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
    setBillingStatus("Estimate failed. Fix input and retry.", "error");
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
      setImportStatus("Sample estimate ready. Edit YAML, import yours, or continue to checkout.");
    } catch (error) {
      setImportStatus(`Sample estimate failed: ${error.message}`, true);
      recommendationEl.textContent = `Could not generate estimate: ${error.message}`;
      resultSection.hidden = false;
      setBillingStatus("Sample generation failed.", "error");
    } finally {
      setBusyState(false);
    }
  });
}

async function openCheckout({ bootstrapEstimate = false } = {}) {
  checkoutBtn.disabled = true;
  if (startPaidBtn) {
    startPaidBtn.disabled = true;
  }
  let checkoutWindow = null;
  setBillingStatus("Preparing checkout...", "neutral", null);

  try {
    if (bootstrapEstimate && !activeSessionId) {
      await generateEstimate({
        workflowYamlOverride: workflowYamlInput.value.trim() || DEFAULT_WORKFLOW_YAML,
        estimateIntent: "paid_cta_bootstrap",
        scrollToResult: false
      });
      setImportStatus("Checkout-ready estimate generated. Review details below after payment.");
    }
    const sessionId = requireSessionId();
    checkoutWindow = window.open("", "_blank", "noopener,noreferrer");
    const payload = await postJson("/api/billing/checkout", {
      sessionId,
      source: activeSource,
      selfTest: isSelfTest
    });

    const url = payload.paymentUrl || activePaymentUrl;
    if (!url) {
      throw new Error("missing_payment_url");
    }
    if (checkoutWindow && !checkoutWindow.closed) {
      checkoutWindow.location.replace(url);
      setBillingStatus("Checkout opened in a new tab. Submit payment proof here to unlock export.", "ok", null);
    } else {
      setBillingStatus("Checkout session ready. Open the link below, then submit payment proof here.", "ok", url);
    }
    setProofFormVisibility(true);
    resultSection.hidden = false;
  } catch (error) {
    if (checkoutWindow && !checkoutWindow.closed) {
      checkoutWindow.close();
    }
    const message =
      error.message === "session_not_ready"
        ? "Generate an estimate before checkout."
        : `Checkout could not start: ${error.message}`;
    setBillingStatus(message, "error", null);
  } finally {
    checkoutBtn.disabled = false;
    if (startPaidBtn) {
      startPaidBtn.disabled = false;
    }
  }
}

checkoutBtn.addEventListener("click", async () => {
  await openCheckout();
});

if (startPaidBtn) {
  startPaidBtn.addEventListener("click", async () => {
    await openCheckout({ bootstrapEstimate: true });
  });
}

proofForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  proofBtn.disabled = true;
  setBillingStatus("Submitting payment proof...", "neutral");

  try {
    const sessionId = requireSessionId();
    const formData = new FormData(proofForm);
    await postJson("/api/billing/proof", {
      sessionId,
      payerEmail: String(formData.get("payerEmail") || "").trim(),
      transactionId: String(formData.get("transactionId") || "").trim(),
      evidenceUrl: String(formData.get("evidenceUrl") || "").trim(),
      note: String(formData.get("note") || "").trim(),
      source: activeSource,
      selfTest: isSelfTest
    });
    exportUnlocked = true;
    setBillingStatus("Payment proof accepted. Export is unlocked.", "ok");
  } catch (error) {
    const message =
      error.message === "session_not_ready"
        ? "Generate an estimate before submitting proof."
        : `Payment proof failed: ${error.message}`;
    setBillingStatus(message, "error");
  } finally {
    proofBtn.disabled = false;
  }
});

exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  setBillingStatus("Preparing export...", "neutral");

  try {
    const sessionId = requireSessionId();
    if (!exportUnlocked) {
      throw new Error("payment_required");
    }

    const payload = await postJson("/api/export/policy-pack", {
      sessionId,
      source: activeSource,
      selfTest: isSelfTest
    });

    exportOutput.textContent = String(payload.content || "");
    exportOutput.hidden = false;
    setBillingStatus(`Policy pack ready: ${payload.fileName || "policy-pack.txt"}`, "ok");
  } catch (error) {
    const message =
      error.message === "payment_required"
        ? "Complete checkout and payment proof first."
        : error.message === "session_not_ready"
          ? "Generate an estimate before export."
          : `Export failed: ${error.message}`;
    setBillingStatus(message, "error");
  } finally {
    exportBtn.disabled = false;
  }
});

if (shouldRunAutoPreview()) {
  window.setTimeout(() => {
    void runAutoPreview();
  }, 400);
}

postJson("/api/events/landing-view", {
  source: activeSource,
  selfTest: isSelfTest,
  userAgent: navigator.userAgent
}).catch(() => undefined);
