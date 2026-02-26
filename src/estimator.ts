export type PolicyMode = "warn" | "block";

export type EstimateInput = {
  workflowYaml: string;
  monthlyRuns: number;
  budgetUsd: number;
  policyMode: PolicyMode;
};

export type OsEstimate = {
  os: string;
  jobs: number;
  stepCount: number;
  minutesPerRun: number;
  costPerRunUsd: number;
};

export type EstimateResult = {
  summary: {
    jobs: number;
    stepCount: number;
    minutesPerRun: number;
    costPerRunUsd: number;
    monthlyRuns: number;
    monthlyCostUsd: number;
    budgetUsd: number;
    policyMode: PolicyMode;
    policyDecision: "pass" | "warn" | "block";
  };
  byOs: OsEstimate[];
  assumptions: string[];
};

const OS_RATE_PER_MINUTE_USD: Record<string, number> = {
  linux: 0.008,
  windows: 0.016,
  macos: 0.08
};

const STEP_MINUTES = {
  uses: 1.5,
  run: 3
};

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseRunsOn(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized.includes("windows")) {
    return "windows";
  }
  if (normalized.includes("macos") || normalized.includes("mac")) {
    return "macos";
  }
  return "linux";
}

function parseJobsAndSteps(workflowYaml: string): Array<{ os: string; steps: number; minutes: number }> {
  const lines = workflowYaml.split(/\r?\n/);
  const jobs: Array<{ os: string; steps: number; minutes: number }> = [];

  let inJobs = false;
  let currentJob: { os: string; steps: number; minutes: number } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "");
    const trimmed = line.trim();

    if (!inJobs && /^jobs\s*:/.test(trimmed)) {
      inJobs = true;
      continue;
    }
    if (!inJobs || !trimmed) {
      continue;
    }

    const isJobHeader = /^\s{2}[a-zA-Z0-9_-]+\s*:\s*$/.test(line);
    if (isJobHeader) {
      if (currentJob) {
        jobs.push(currentJob);
      }
      currentJob = { os: "linux", steps: 0, minutes: 2 };
      continue;
    }

    if (!currentJob) {
      continue;
    }

    const runsOnMatch = line.match(/^\s{4}runs-on\s*:\s*(.+)\s*$/);
    if (runsOnMatch) {
      currentJob.os = parseRunsOn(runsOnMatch[1]);
      continue;
    }

    if (/^\s{6}-\s+uses\s*:/.test(line)) {
      currentJob.steps += 1;
      currentJob.minutes += STEP_MINUTES.uses;
      continue;
    }

    if (/^\s{6}-\s+run\s*:/.test(line)) {
      currentJob.steps += 1;
      currentJob.minutes += STEP_MINUTES.run;
      continue;
    }

  }

  if (currentJob) {
    jobs.push(currentJob);
  }

  if (!jobs.length) {
    jobs.push({ os: "linux", steps: 3, minutes: 8.5 });
  }

  return jobs;
}

function aggregateByOs(jobs: Array<{ os: string; steps: number; minutes: number }>): OsEstimate[] {
  const byOsMap = new Map<string, OsEstimate>();
  for (const job of jobs) {
    const rate = OS_RATE_PER_MINUTE_USD[job.os] ?? OS_RATE_PER_MINUTE_USD.linux;
    const existing = byOsMap.get(job.os) ?? {
      os: job.os,
      jobs: 0,
      stepCount: 0,
      minutesPerRun: 0,
      costPerRunUsd: 0
    };
    existing.jobs += 1;
    existing.stepCount += job.steps;
    existing.minutesPerRun += job.minutes;
    existing.costPerRunUsd += job.minutes * rate;
    byOsMap.set(job.os, existing);
  }

  return [...byOsMap.values()].map((entry) => ({
    ...entry,
    minutesPerRun: roundMoney(entry.minutesPerRun),
    costPerRunUsd: roundMoney(entry.costPerRunUsd)
  }));
}

export function sanitizeEstimateInput(payload: Record<string, unknown>): EstimateInput {
  const workflowYaml = typeof payload.workflowYaml === "string" ? payload.workflowYaml.trim() : "";
  if (!workflowYaml || workflowYaml.length > 100000) {
    throw new Error("invalid_workflow_yaml");
  }

  const monthlyRunsRaw = payload.monthlyRuns;
  const monthlyRuns = typeof monthlyRunsRaw === "number" ? monthlyRunsRaw : Number.parseFloat(String(monthlyRunsRaw));
  if (!Number.isFinite(monthlyRuns) || monthlyRuns <= 0 || monthlyRuns > 1000000) {
    throw new Error("invalid_monthly_runs");
  }

  const budgetRaw = payload.budgetUsd;
  const budgetUsd = typeof budgetRaw === "number" ? budgetRaw : Number.parseFloat(String(budgetRaw));
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 1000000) {
    throw new Error("invalid_budget_usd");
  }

  const modeRaw = typeof payload.policyMode === "string" ? payload.policyMode.trim().toLowerCase() : "";
  if (modeRaw !== "warn" && modeRaw !== "block") {
    throw new Error("invalid_policy_mode");
  }

  return {
    workflowYaml,
    monthlyRuns: Math.round(monthlyRuns),
    budgetUsd: roundMoney(budgetUsd),
    policyMode: modeRaw
  };
}

export function estimateWorkflowCost(input: EstimateInput): EstimateResult {
  const jobs = parseJobsAndSteps(input.workflowYaml);
  const byOs = aggregateByOs(jobs);

  let minutesPerRun = 0;
  let costPerRunUsd = 0;
  let totalJobs = 0;
  let totalSteps = 0;

  for (const osEntry of byOs) {
    minutesPerRun += osEntry.minutesPerRun;
    costPerRunUsd += osEntry.costPerRunUsd;
    totalJobs += osEntry.jobs;
    totalSteps += osEntry.stepCount;
  }

  const monthlyCostUsd = roundMoney(costPerRunUsd * input.monthlyRuns);
  const policyDecision = monthlyCostUsd > input.budgetUsd ? input.policyMode : "pass";

  return {
    summary: {
      jobs: totalJobs,
      stepCount: totalSteps,
      minutesPerRun: roundMoney(minutesPerRun),
      costPerRunUsd: roundMoney(costPerRunUsd),
      monthlyRuns: input.monthlyRuns,
      monthlyCostUsd,
      budgetUsd: input.budgetUsd,
      policyMode: input.policyMode,
      policyDecision
    },
    byOs,
    assumptions: [
      "Default base runtime is 2 minutes per job before step costs.",
      "Step runtime assumptions: uses=1.5m, run=3m.",
      "Hosted runner rates used: Linux $0.008/min, Windows $0.016/min, macOS $0.08/min.",
      "Matrix expansion is not modeled explicitly unless represented as separate jobs in YAML."
    ]
  };
}
