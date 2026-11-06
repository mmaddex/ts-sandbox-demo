// The editor's backend. It serves the web UI, starts the `runPipeline` workflow task, and reports
// each step's progress. It holds the Render API key; the browser never sees it.
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Render } from "@renderinc/sdk";
import type { BlockResult, Pipeline, PipelineResult, PipelineStep } from "./types.ts";

const PORT = Number(process.env.PORT ?? 3000);
// Locally, `render workflows dev` accepts any workflow slug. On Render, use the workflow's slug.
const WORKFLOW_SLUG = process.env.WORKFLOW_SLUG ?? "sandbox-pipeline";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_DIR = join(ROOT, "web");
const EXAMPLES_DIR = join(ROOT, "examples");
const MONACO_DIR = join(ROOT, "node_modules/monaco-editor/min/vs");

const LIMITS = {
  steps: 10,
  codeChars: 100_000,
  requestBytes: 1_000_000,
  domains: 20,
  timeoutSeconds: 60,
};
const DOMAIN_PATTERN = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/i;
const TERMINAL = new Set(["completed", "succeeded", "failed", "canceled"]);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
};

const workflows = new Render().workflows;

interface StepView {
  taskRunId: string;
  status: string;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: BlockResult;
}

// Finished step runs never change, so each is fetched once.
const finishedSteps = new Map<string, { stepId: string; view: StepView }>();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/examples") {
    return sendJson(res, 200, await listExamples());
  }
  if (req.method === "POST" && path === "/api/runs") {
    const pipeline = parsePipeline(await readJson(req));
    const run = await workflows.startTask(`${WORKFLOW_SLUG}/runPipeline`, [pipeline]);
    return sendJson(res, 201, { id: run.taskRunId });
  }

  const runMatch = path.match(/^\/api\/runs\/([\w-]+)(\/cancel)?$/);
  if (runMatch && req.method === "GET" && !runMatch[2]) {
    return sendJson(res, 200, await describeRun(runMatch[1]));
  }
  if (runMatch && req.method === "POST" && runMatch[2]) {
    await workflows.cancelTaskRun(runMatch[1]);
    return sendJson(res, 202, {});
  }

  if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
  if (path.startsWith("/vs/")) return sendFile(res, MONACO_DIR, path.slice("/vs/".length));
  return sendFile(res, WEB_DIR, path === "/" ? "index.html" : path.slice(1));
}

/** The root run, plus one view per step that has started, keyed by step id. */
async function describeRun(id: string) {
  const [root, children] = await Promise.all([
    workflows.getTaskRun(id),
    workflows.listTaskRuns({ rootTaskRunId: [id], limit: 100 }),
  ]);

  const steps: Record<string, StepView> = {};
  const stepRuns = children
    // The API wraps each run as { taskRun, cursor }; the local dev server returns runs directly.
    .map((item) => ((item as { taskRun?: unknown }).taskRun ?? item) as typeof item.taskRun)
    .filter((run) => run.parentTaskRunId === id);

  await Promise.all(
    stepRuns.map(async (run) => {
      const step = finishedSteps.get(run.id) ?? (await describeStep(run.id));
      steps[step.stepId] = step.view;
    }),
  );

  return {
    id,
    status: root.status,
    startedAt: root.startedAt,
    completedAt: root.completedAt,
    error: root.error,
    result: firstResult<PipelineResult>(root.results),
    steps,
  };
}

async function describeStep(taskRunId: string) {
  const run = await workflows.getTaskRun(taskRunId);
  const [step] = run.input as [PipelineStep, unknown];
  const view: StepView = {
    taskRunId,
    status: run.status,
    attempts: run.attempts?.length ?? 1,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
    result: firstResult<BlockResult>(run.results),
  };
  const described = { stepId: step.id, view };
  if (TERMINAL.has(run.status)) finishedSteps.set(taskRunId, described);
  return described;
}

function firstResult<T>(results: unknown): T | undefined {
  return Array.isArray(results) ? (results[0] as T) : undefined;
}

/** Everything in examples/, so the editor can start a step from one. */
async function listExamples() {
  const files = await readdir(EXAMPLES_DIR, { recursive: true });
  const examples = await Promise.all(
    files
      .filter((file) => file.endsWith(".mts"))
      .sort()
      .map(async (file) => ({
        name: file.replace(/\.mts$/, ""),
        code: await readFile(join(EXAMPLES_DIR, file), "utf8"),
      })),
  );
  return examples;
}

/** The workflow runs whatever this returns, so check shape and limits before starting it. */
function parsePipeline(body: unknown): Pipeline {
  if (!isRecord(body) || !Array.isArray(body.steps)) {
    throw new HttpError(400, "Expected { input, steps: [...] }");
  }
  if (body.steps.length === 0 || body.steps.length > LIMITS.steps) {
    throw new HttpError(400, `A pipeline needs 1 to ${LIMITS.steps} steps`);
  }

  const steps = body.steps.map((raw, index): PipelineStep => {
    const label = `Step ${index + 1}`;
    if (!isRecord(raw)) throw new HttpError(400, `${label} is not an object`);
    const { id, name, code, allowedDomains = [], timeoutSeconds = 10 } = raw;

    if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) {
      throw new HttpError(400, `${label} needs an id`);
    }
    if (typeof code !== "string" || code.trim() === "" || code.length > LIMITS.codeChars) {
      throw new HttpError(400, `${label} needs code under ${LIMITS.codeChars} characters`);
    }
    if (
      !Array.isArray(allowedDomains) ||
      allowedDomains.length > LIMITS.domains ||
      !allowedDomains.every((d) => typeof d === "string" && DOMAIN_PATTERN.test(d))
    ) {
      throw new HttpError(400, `${label} has an invalid allowed domain`);
    }
    if (
      !Number.isInteger(timeoutSeconds) ||
      (timeoutSeconds as number) < 1 ||
      (timeoutSeconds as number) > LIMITS.timeoutSeconds
    ) {
      throw new HttpError(400, `${label} timeout must be 1 to ${LIMITS.timeoutSeconds} seconds`);
    }

    return {
      id,
      name: typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : label,
      code,
      allowedDomains: allowedDomains as string[],
      timeoutSeconds: timeoutSeconds as number,
    };
  });

  return { input: body.input ?? null, steps };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > LIMITS.requestBytes) throw new HttpError(413, "Request is too large");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

async function sendFile(res: ServerResponse, dir: string, file: string) {
  const fullPath = normalize(join(dir, decodeURIComponent(file)));
  if (relative(dir, fullPath).startsWith("..")) throw new HttpError(404, "Not found");
  const data = await readFile(fullPath).catch(() => {
    throw new HttpError(404, "Not found");
  });
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(fullPath)] ?? "application/octet-stream",
  });
  res.end(data);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 502;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) console.error(err);
    sendJson(res, status, { error: message });
  });
}).listen(PORT, () => {
  console.log(`Editor on http://localhost:${PORT} (tasks: ${WORKFLOW_SLUG}/runPipeline)`);
});
