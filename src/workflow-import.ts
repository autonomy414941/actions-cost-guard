const MAX_WORKFLOW_YAML_BYTES = 100_000;
const WORKFLOW_FETCH_TIMEOUT_MS = 8_000;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function sanitizeWorkflowUrl(payload: Record<string, unknown>): string {
  const workflowUrl = typeof payload.workflowUrl === "string" ? payload.workflowUrl.trim() : "";
  if (!workflowUrl || workflowUrl.length > 2048) {
    throw new Error("invalid_workflow_url");
  }
  return workflowUrl;
}

function assertYamlPath(pathname: string): void {
  if (!/\.ya?ml$/i.test(pathname)) {
    throw new Error("invalid_workflow_path");
  }
}

export function resolveRawWorkflowUrl(workflowUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(workflowUrl);
  } catch {
    throw new Error("invalid_workflow_url");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("invalid_workflow_url");
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "raw.githubusercontent.com") {
    assertYamlPath(parsed.pathname);
    return parsed.toString();
  }

  if (host !== "github.com") {
    throw new Error("invalid_workflow_host");
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 6) {
    throw new Error("invalid_workflow_path");
  }

  const [owner, repo, mode, ref, ...fileParts] = segments;
  if ((mode !== "blob" && mode !== "raw") || !owner || !repo || !ref || !fileParts.length) {
    throw new Error("invalid_workflow_path");
  }

  const filePath = fileParts.join("/");
  assertYamlPath(filePath);

  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
}

export async function fetchWorkflowYaml(rawWorkflowUrl: string, fetchFn: FetchFn = fetch): Promise<string> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, WORKFLOW_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchFn(rawWorkflowUrl, {
      signal: abortController.signal,
      redirect: "follow",
      headers: {
        "user-agent": "actions-cost-guard/0.1"
      }
    });
    if (!response.ok) {
      throw new Error("workflow_fetch_failed");
    }

    const workflowYaml = await response.text();
    const payloadSize = Buffer.byteLength(workflowYaml, "utf8");
    if (!workflowYaml.trim()) {
      throw new Error("workflow_empty");
    }
    if (payloadSize > MAX_WORKFLOW_YAML_BYTES) {
      throw new Error("workflow_too_large");
    }
    return workflowYaml;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("workflow_fetch_timeout");
    }
    if (error instanceof Error && /^workflow_[a-z0-9_]+$/.test(error.message)) {
      throw error;
    }
    throw new Error("workflow_fetch_failed");
  } finally {
    clearTimeout(timeout);
  }
}
