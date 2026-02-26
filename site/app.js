const estimateForm = document.getElementById("estimate-form");
const resultSection = document.getElementById("result");
const recommendationEl = document.getElementById("recommendation");
const summaryEl = document.getElementById("summary");
const policySnippetEl = document.getElementById("policy-snippet");
const checkoutBtn = document.getElementById("checkout-btn");
const submitBtn = document.getElementById("submit-btn");

let activeSessionId = null;
let activePaymentUrl = null;

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

estimateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitBtn.disabled = true;

  const workflowYaml = document.getElementById("workflow-yaml").value;
  const monthlyRuns = Number(document.getElementById("monthly-runs").value);
  const budgetUsd = Number(document.getElementById("budget-usd").value);
  const policyMode = document.getElementById("policy-mode").value;

  try {
    const payload = await postJson("/api/estimate", {
      workflowYaml,
      monthlyRuns,
      budgetUsd,
      policyMode,
      source: "web",
      selfTest: false
    });

    activeSessionId = payload.sessionId;
    activePaymentUrl = payload.checkout?.paymentUrl || null;
    renderEstimate(payload);
  } catch (error) {
    recommendationEl.textContent = `Could not generate estimate: ${error.message}`;
    resultSection.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

checkoutBtn.addEventListener("click", async () => {
  if (!activeSessionId) {
    recommendationEl.textContent = "Generate an estimate before checkout.";
    return;
  }

  checkoutBtn.disabled = true;
  try {
    const payload = await postJson("/api/billing/checkout", {
      sessionId: activeSessionId,
      source: "web",
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

postJson("/api/events/landing-view", {
  source: "web",
  selfTest: false,
  userAgent: navigator.userAgent
}).catch(() => undefined);
