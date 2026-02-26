import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateWorkflowCost, sanitizeEstimateInput } from "./estimator.js";
import { fetchWorkflowYaml, resolveRawWorkflowUrl, sanitizeWorkflowUrl } from "./workflow-import.js";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const DATA_DIR = process.env.DATA_DIR || "/data";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://actions-cost-guard.devtoolbox.dedyn.io";
const PAYMENT_URL = process.env.PAYMENT_URL || "https://buy.stripe.com/test_eVq6oH8mqf5WeQJ2jQ";
const PRICE_USD = Number.parseFloat(process.env.PRICE_USD || "19");

const STATE_FILE = path.join(DATA_DIR, "state.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const SITE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../site");

type EventType = "landing_view" | "estimate_generated" | "checkout_started";

type EstimateSession = {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  source: string;
  selfTest: boolean;
  budgetUsd: number;
  monthlyRuns: number;
  monthlyCostUsd: number;
  policyDecision: "pass" | "warn" | "block";
};

type EventRecord = {
  eventId: string;
  eventType: EventType;
  timestamp: string;
  source: string;
  selfTest: boolean;
  sessionId: string | null;
  details: Record<string, unknown>;
};

type State = {
  sessions: Record<string, EstimateSession>;
  events: EventRecord[];
};

type JsonObject = Record<string, unknown>;

type MetricsCounts = Record<EventType, number>;

const STATIC_MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const EVENT_TYPES: EventType[] = ["landing_view", "estimate_generated", "checkout_started"];

const state: State = {
  sessions: {},
  events: []
};

let stateWriteQueue = Promise.resolve();
let eventWriteQueue = Promise.resolve();

function parseBoolean(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

function normalizeSource(value: unknown, fallback = "web"): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(normalized)) {
    return fallback;
  }
  return normalized;
}

function emptyCounts(): MetricsCounts {
  return {
    landing_view: 0,
    estimate_generated: 0,
    checkout_started: 0
  };
}

function calculateCounts(selfTestFilter?: boolean): MetricsCounts {
  const counts = emptyCounts();
  for (const event of state.events) {
    if (typeof selfTestFilter === "boolean" && event.selfTest !== selfTestFilter) {
      continue;
    }
    counts[event.eventType] += 1;
  }
  return counts;
}

async function saveState(): Promise<void> {
  const payload = JSON.stringify(state);
  stateWriteQueue = stateWriteQueue
    .catch(() => undefined)
    .then(() => writeFile(STATE_FILE, payload, "utf8"));
  await stateWriteQueue;
}

async function appendEvent(record: EventRecord): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  eventWriteQueue = eventWriteQueue
    .catch(() => undefined)
    .then(() => appendFile(EVENTS_FILE, line, "utf8"));
  await eventWriteQueue;
}

async function trackEvent(
  eventType: EventType,
  options: {
    source: string;
    selfTest: boolean;
    sessionId?: string | null;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  const record: EventRecord = {
    eventId: randomUUID(),
    eventType,
    timestamp: new Date().toISOString(),
    source: options.source,
    selfTest: options.selfTest,
    sessionId: options.sessionId ?? null,
    details: options.details ?? {}
  };
  state.events.push(record);
  await Promise.all([appendEvent(record), saveState()]);
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  response.end(JSON.stringify(payload));
}

function sendText(response: http.ServerResponse, statusCode: number, text: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(text);
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    (/^invalid_[a-z0-9_]+$/.test(error.message) || /^workflow_[a-z0-9_]+$/.test(error.message))
  ) {
    return error.message;
  }
  return "invalid_request";
}

async function parseBody(request: http.IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error("payload_too_large");
    }
    chunks.push(buffer);
  }
  if (!chunks.length) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_json");
  }
  return parsed as JsonObject;
}

async function serveStatic(requestPath: string, response: http.ServerResponse): Promise<boolean> {
  const pathname = requestPath === "/" ? "/index.html" : requestPath;
  const normalized = path.posix.normalize(pathname);
  if (normalized.includes("..")) {
    return false;
  }
  const filePath = path.join(SITE_DIR, normalized);
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "content-type": STATIC_MIME[ext] ?? "application/octet-stream"
    });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

async function loadState(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    if (parsed?.sessions && typeof parsed.sessions === "object") {
      state.sessions = parsed.sessions as Record<string, EstimateSession>;
    }
    if (Array.isArray(parsed?.events)) {
      state.events = parsed.events.filter((event): event is EventRecord => {
        return !!event && typeof event === "object" && EVENT_TYPES.includes((event as EventRecord).eventType);
      });
    }
  } catch {
    await saveState();
  }
  await appendFile(EVENTS_FILE, "", "utf8");
}

function buildRecommendation(decision: "pass" | "warn" | "block", monthlyCostUsd: number, budgetUsd: number): string {
  if (decision === "pass") {
    return `Estimated monthly spend $${monthlyCostUsd.toFixed(2)} is within budget ($${budgetUsd.toFixed(2)}).`;
  }
  if (decision === "warn") {
    return `Estimated monthly spend $${monthlyCostUsd.toFixed(2)} exceeds budget ($${budgetUsd.toFixed(2)}). Keep merge open but require owner approval.`;
  }
  return `Estimated monthly spend $${monthlyCostUsd.toFixed(2)} exceeds budget ($${budgetUsd.toFixed(2)}). Block merge until workflow cost is reduced.`;
}

const server = http.createServer(async (request, response) => {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", PUBLIC_BASE_URL);

  if (method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    response.end();
    return;
  }

  try {
    if (method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
      sendJson(response, 200, {
        status: "ok",
        service: "actions-cost-guard",
        time: new Date().toISOString()
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/events/landing-view") {
      const body = await parseBody(request);
      const source = normalizeSource(body.source, "web");
      const selfTest = parseBoolean(body.selfTest);
      await trackEvent("landing_view", {
        source,
        selfTest,
        details: {
          userAgent: typeof body.userAgent === "string" ? body.userAgent.slice(0, 200) : undefined
        }
      });
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (method === "POST" && url.pathname === "/api/estimate") {
      const body = await parseBody(request);
      const source = normalizeSource(body.source, "web");
      const selfTest = parseBoolean(body.selfTest);
      const estimateInput = sanitizeEstimateInput(body);
      const estimate = estimateWorkflowCost(estimateInput);

      const sessionId = randomUUID();
      const now = new Date().toISOString();
      state.sessions[sessionId] = {
        sessionId,
        createdAt: now,
        updatedAt: now,
        source,
        selfTest,
        budgetUsd: estimate.summary.budgetUsd,
        monthlyRuns: estimate.summary.monthlyRuns,
        monthlyCostUsd: estimate.summary.monthlyCostUsd,
        policyDecision: estimate.summary.policyDecision
      };

      await Promise.all([
        saveState(),
        trackEvent("estimate_generated", {
          source,
          selfTest,
          sessionId,
          details: {
            monthlyCostUsd: estimate.summary.monthlyCostUsd,
            budgetUsd: estimate.summary.budgetUsd,
            policyDecision: estimate.summary.policyDecision
          }
        })
      ]);

      sendJson(response, 200, {
        status: "ok",
        sessionId,
        estimate,
        recommendation: buildRecommendation(
          estimate.summary.policyDecision,
          estimate.summary.monthlyCostUsd,
          estimate.summary.budgetUsd
        ),
        checkout: {
          endpoint: "/api/billing/checkout",
          priceUsd: PRICE_USD
        }
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/workflow/import") {
      const body = await parseBody(request);
      const workflowUrl = sanitizeWorkflowUrl(body);
      const rawWorkflowUrl = resolveRawWorkflowUrl(workflowUrl);
      const workflowYaml = await fetchWorkflowYaml(rawWorkflowUrl);

      sendJson(response, 200, {
        status: "ok",
        sourceUrl: rawWorkflowUrl,
        workflowYaml
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/billing/checkout") {
      const body = await parseBody(request);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      if (!sessionId || !state.sessions[sessionId]) {
        throw new Error("invalid_session_id");
      }
      const session = state.sessions[sessionId];
      const source = normalizeSource(body.source, session.source);
      const selfTest = parseBoolean(body.selfTest) || session.selfTest;

      await trackEvent("checkout_started", {
        source,
        selfTest,
        sessionId,
        details: {
          monthlyCostUsd: session.monthlyCostUsd,
          budgetUsd: session.budgetUsd,
          policyDecision: session.policyDecision,
          priceUsd: PRICE_USD
        }
      });

      sendJson(response, 200, {
        status: "ok",
        checkoutMode: "payment_link",
        paymentUrl: PAYMENT_URL,
        priceUsd: PRICE_USD
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/metrics") {
      sendJson(response, 200, {
        totals: {
          includingSelfTests: calculateCounts(),
          excludingSelfTests: calculateCounts(false)
        },
        sessionCount: Object.keys(state.sessions).length,
        generatedAt: new Date().toISOString()
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/metrics/daily") {
      const buckets: Record<string, MetricsCounts> = {};
      for (const event of state.events) {
        const day = event.timestamp.slice(0, 10);
        if (!buckets[day]) {
          buckets[day] = emptyCounts();
        }
        buckets[day][event.eventType] += 1;
      }
      sendJson(response, 200, {
        daily: buckets,
        generatedAt: new Date().toISOString()
      });
      return;
    }

    if (method === "GET") {
      const served = await serveStatic(url.pathname, response);
      if (served) {
        return;
      }
    }

    sendJson(response, 404, {
      error: "not_found"
    });
  } catch (error) {
    const code = safeErrorCode(error);
    if (code === "payload_too_large") {
      sendJson(response, 413, { error: code });
      return;
    }
    sendJson(response, 400, { error: code });
  }
});

loadState()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`actions-cost-guard listening on ${HOST}:${PORT}`);
    });
  })
  .catch((error: unknown) => {
    console.error("failed_to_start", error);
    process.exitCode = 1;
  });
