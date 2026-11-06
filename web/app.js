// The pipeline editor. Steps live in the browser (and localStorage) until you press Run; the
// server then starts the `runPipeline` workflow task, and this page polls it for progress.

const STORAGE_KEY = "sandbox-pipeline:v1";
const TERMINAL = new Set(["completed", "succeeded", "failed", "canceled"]);
const INPUT = "input";

// Examples that need network access, and the hosts their sandbox may reach.
const EXAMPLE_DOMAINS = {
  "github-stars": ["api.github.com"],
  "zod-axios": ["api.github.com"],
  "brokered-openai": ["api.openai.com"],
  "hostile/exfiltrate": ["api.github.com"],
};

const BLANK_STEP = `// Receives the previous step's output (or the pipeline input) and returns this step's output.
// Imports: Node built-ins, zod, and axios.
export default async function (input: unknown) {
  return input;
}
`;

// Libraries in the runner snapshot load as untyped modules here; the sandbox has the real ones.
const EDITOR_TYPES = `
declare module "*";
declare const process: any;
declare namespace NodeJS { type Process = any; }
`;

const state = {
  input: "",
  steps: [],
  selected: INPUT,
  runId: null,
  run: null,
  runError: null,
  /** A failed action on the current run, such as a cancel the server refused. */
  notice: null,
  starting: false,
};

let monaco;
let editor;
let examples = [];
let pollTimer;
const models = new Map();

const $ = (selector) => document.querySelector(selector);

boot().catch((err) => setRunStatus(`Couldn't load the editor: ${err.message}`, true));

async function boot() {
  [monaco, examples] = await Promise.all([loadMonaco(), fetchJson("/api/examples")]);
  configureMonaco();

  Object.assign(state, loadDraft() ?? defaultPipeline());
  if (!stepById(state.selected)) state.selected = INPUT;
  editor = monaco.editor.create($("#editor"), {
    model: modelFor(state.selected),
    theme: "render-code",
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: "'PP Neue Montreal Mono', 'Roboto Mono', ui-monospace, Menlo, monospace",
    fontSize: 13,
    lineHeight: 20,
    padding: { top: 12 },
    scrollBeyondLastLine: false,
    tabSize: 2,
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, startRun);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") startRun();
  });
  document.fonts.ready.then(() => monaco.editor.remeasureFonts());

  $("#example").replaceChildren(
    h("option", { value: "" }, "Blank step"),
    ...examples.map((example) => h("option", { value: example.name }, example.name)),
  );
  $("#add-step").addEventListener("click", () => addStep($("#example").value));
  $("#reset").addEventListener("click", resetPipeline);
  $("#run").addEventListener("click", startRun);
  $("#run").title = `Run (${navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl"}+Enter)`;
  $("#cancel").addEventListener("click", cancelRun);

  select(state.selected);
  if (state.runId) poll();
}

function loadMonaco() {
  return new Promise((resolve, reject) => {
    window.require.config({ paths: { vs: "/vs" } });
    window.require(["vs/editor/editor.main"], (main) => resolve(window.monaco ?? main.m ?? main), reject);
  });
}

function configureMonaco() {
  const ts = monaco.typescript ?? monaco.languages.typescript;
  ts.typescriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    strict: true,
  });
  ts.typescriptDefaults.addExtraLib(EDITOR_TYPES, "file:///runner-env.d.ts");

  // Code stays dark in both themes, with Render's code syntax palette.
  monaco.editor.defineTheme("render-code", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "C29EFF" },
      { token: "string", foreground: "EABE95" },
      { token: "string.escape", foreground: "EABE95" },
      { token: "number", foreground: "FAF1A3" },
      { token: "regexp", foreground: "EABE95" },
      { token: "type", foreground: "FFFBC2" },
      { token: "type.identifier", foreground: "FFFBC2" },
      { token: "comment", foreground: "8F8F8F" },
      { token: "comment.doc", foreground: "5DEBE9" },
      { token: "delimiter", foreground: "8F8F8F" },
      { token: "identifier", foreground: "F0F0F0" },
      { token: "string.key.json", foreground: "C29EFF" },
      { token: "string.value.json", foreground: "EABE95" },
    ],
    colors: {
      "editor.background": "#141414",
      "editor.foreground": "#F0F0F0",
      "editorLineNumber.foreground": "#4D4D4D",
      "editorLineNumber.activeForeground": "#B3B3B3",
      "editor.lineHighlightBackground": "#1C1C1C",
      "editor.lineHighlightBorder": "#1C1C1C",
      "editor.selectionBackground": "#411D92",
      "editorCursor.foreground": "#FFFFFF",
      "editorIndentGuide.background1": "#272727",
    },
  });
}

// --- Pipeline state -------------------------------------------------------------------------

function defaultPipeline() {
  return {
    input: JSON.stringify({ repo: "render-oss/sdk" }, null, 2),
    steps: [newStep("zod-axios", "Fetch repo"), newStep("summarize", "Summarize")],
    selected: INPUT,
    runId: null,
    run: null,
  };
}

function newStep(exampleName, name) {
  const example = examples.find((e) => e.name === exampleName);
  return {
    id: crypto.randomUUID().slice(0, 8),
    name: name ?? (example ? example.name.replace(/^hostile\//, "") : "New step"),
    code: example?.code ?? BLANK_STEP,
    allowedDomains: EXAMPLE_DOMAINS[exampleName] ?? [],
    timeoutSeconds: 10,
  };
}

function addStep(exampleName) {
  if (state.steps.length >= 10) return setRunStatus("A pipeline can have at most 10 steps.", true);
  const step = newStep(exampleName || null);
  state.steps.push(step);
  saveDraft();
  select(step.id);
}

function removeStep(id) {
  const index = state.steps.findIndex((step) => step.id === id);
  state.steps.splice(index, 1);
  models.get(id)?.dispose();
  models.delete(id);
  saveDraft();
  select(state.steps[Math.min(index, state.steps.length - 1)]?.id ?? INPUT);
}

function moveStep(id, offset) {
  const index = state.steps.findIndex((step) => step.id === id);
  const target = index + offset;
  if (target < 0 || target >= state.steps.length) return;
  [state.steps[index], state.steps[target]] = [state.steps[target], state.steps[index]];
  saveDraft();
  renderSteps();
  renderSettings();
}

function resetPipeline() {
  if (!confirm("Replace this pipeline with the starter example?")) return;
  editor.setModel(null);
  for (const model of models.values()) model.dispose();
  models.clear();
  stopPolling();
  Object.assign(state, defaultPipeline(), { runError: null });
  saveDraft();
  select(INPUT);
}

function stepById(id) {
  if (id === INPUT) return true;
  return state.steps.find((step) => step.id === id);
}

function modelFor(id) {
  let model = models.get(id);
  if (model) return model;

  if (id === INPUT) {
    model = monaco.editor.createModel(state.input, "json", monaco.Uri.parse("file:///input.json"));
    model.onDidChangeContent(() => {
      state.input = model.getValue();
      saveDraft();
    });
  } else {
    const step = stepById(id);
    model = monaco.editor.createModel(
      step.code,
      "typescript",
      monaco.Uri.parse(`file:///steps/${id}.ts`),
    );
    model.onDidChangeContent(() => {
      step.code = model.getValue();
      saveDraft();
    });
  }
  models.set(id, model);
  return model;
}

function select(id) {
  state.selected = stepById(id) ? id : INPUT;
  editor.setModel(modelFor(state.selected));
  saveDraft();
  renderSteps();
  renderSettings();
  renderResults();
}

function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(draft?.steps) ? draft : null;
  } catch {
    return null;
  }
}

function saveDraft() {
  const { input, steps, selected, runId } = state;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ input, steps, selected, runId }));
  } catch {
    // Storage can be full or blocked; the editor still works for this session.
  }
}

// --- Running ----------------------------------------------------------------------------------

async function startRun() {
  if (state.starting || isRunning()) return;

  let input;
  try {
    input = JSON.parse(state.input);
  } catch (err) {
    select(INPUT);
    return setRunStatus(`Input isn't valid JSON: ${err.message}`, true);
  }
  if (state.steps.length === 0) return setRunStatus("Add a step first.", true);

  state.starting = true;
  state.run = null;
  state.runError = null;
  state.notice = null;
  renderAll();
  try {
    const steps = state.steps.map(({ id, name, code, allowedDomains, timeoutSeconds }) => ({
      id,
      name,
      code,
      allowedDomains,
      timeoutSeconds,
    }));
    const { id } = await fetchJson("/api/runs", { method: "POST", body: { input, steps } });
    state.runId = id;
    saveDraft();
    poll();
  } catch (err) {
    state.runError = err.message;
  } finally {
    state.starting = false;
    renderAll();
  }
}

async function poll() {
  clearTimeout(pollTimer);
  const runId = state.runId;
  try {
    const run = await fetchJson(`/api/runs/${runId}`);
    if (runId !== state.runId) return;
    state.run = run;
    state.runError = null;
  } catch (err) {
    if (runId !== state.runId) return;
    if (state.run) {
      // Keep trying while the run is in progress; the error clears on the next good response.
      state.runError = `Lost contact with the run: ${err.message}`;
      pollTimer = setTimeout(poll, 3000);
    } else {
      // A run saved by an earlier session may be gone, e.g. after `render workflows dev` restarts.
      state.runId = null;
      saveDraft();
    }
    return renderAll();
  }
  renderAll();
  if (!TERMINAL.has(state.run.status)) pollTimer = setTimeout(poll, 1000);
}

function stopPolling() {
  clearTimeout(pollTimer);
}

async function cancelRun() {
  if (!state.runId) return;
  try {
    await fetchJson(`/api/runs/${state.runId}/cancel`, { method: "POST" });
    poll();
  } catch (err) {
    state.notice = `Couldn't cancel: ${err.message}`;
    renderRunControls();
  }
}

function isRunning() {
  return Boolean(state.runId && (!state.run || !TERMINAL.has(state.run.status)));
}

/** One step's state in the current run, in terms the step list and results panel can show. */
function stepState(step) {
  const run = state.run;
  if (!run) return state.runId ? { label: "Waiting", tone: "neutral" } : null;

  const view = run.steps[step.id];
  if (!view) {
    if (!TERMINAL.has(run.status)) return { label: "Waiting", tone: "neutral" };
    return { label: "Not run", tone: "neutral" };
  }

  switch (view.status) {
    case "pending":
      return { label: "Queued", tone: "neutral", view };
    case "running":
      return { label: "Running", tone: "neutral", busy: true, view };
    case "canceled":
      return { label: "Canceled", tone: "neutral", view };
    case "failed":
      return { label: "Failed", tone: "error", view };
    default:
      if (view.result?.ok) return { label: "Succeeded", tone: "success", view };
      if (view.result?.timedOut) return { label: "Timed out", tone: "error", view };
      return { label: "Failed", tone: "error", view };
  }
}

// --- Rendering --------------------------------------------------------------------------------

function renderAll() {
  renderSteps();
  renderResults();
}

function renderSteps() {
  const items = [
    h(
      "li",
      {},
      stepButton(INPUT, "", "Input", "JSON passed to the first step", null),
    ),
  ];
  state.steps.forEach((step, index) => {
    const domains = step.allowedDomains.length ? step.allowedDomains.join(", ") : "No network";
    items.push(h("li", { class: "connector", "aria-hidden": "true" }));
    items.push(h("li", {}, stepButton(step.id, String(index + 1), step.name, domains, stepState(step))));
  });
  $("#step-list").replaceChildren(...items);
  renderRunControls();
}

function stepButton(id, index, name, meta, status) {
  return h(
    "button",
    {
      type: "button",
      class: "step-item",
      "aria-current": String(state.selected === id),
      onclick: () => select(id),
    },
    h("span", { class: "step-index" }, index),
    h("span", { class: "step-text" }, h("span", { class: "step-name" }, name), h("span", { class: "step-meta" }, meta)),
    status ? chip(status) : "",
  );
}

function chip(status) {
  return h(
    "span",
    { class: `chip ${status.tone}` },
    status.busy ? h("span", { class: "spinner", "aria-hidden": "true" }) : "",
    status.label,
  );
}

function renderSettings() {
  const container = $("#settings");
  if (state.selected === INPUT) {
    container.replaceChildren(
      h(
        "p",
        { class: "settings-note" },
        "The pipeline input, as JSON. The first step receives it, and every later step receives the output of the step before it.",
      ),
    );
    return;
  }

  const step = stepById(state.selected);
  const index = state.steps.indexOf(step);
  const update = (patch) => {
    Object.assign(step, patch);
    saveDraft();
    renderSteps();
  };

  container.replaceChildren(
    field("name", "Name", h("input", {
      class: "control",
      value: step.name,
      maxlength: "80",
      oninput: (e) => update({ name: e.target.value }),
    })),
    field("domains", "Allowed domains", h("input", {
      class: "control mono",
      value: step.allowedDomains.join(", "),
      placeholder: "None: no network access",
      spellcheck: "false",
      oninput: (e) =>
        update({
          allowedDomains: e.target.value
            .split(/[\s,]+/)
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean),
        }),
    })),
    field("timeout", "Timeout (s)", h("input", {
      class: "control",
      type: "number",
      min: "1",
      max: "60",
      value: String(step.timeoutSeconds),
      oninput: (e) => update({ timeoutSeconds: Number(e.target.value) }),
    })),
    h(
      "div",
      { class: "step-actions" },
      h("button", { type: "button", class: "button secondary small", disabled: index === 0, "aria-label": "Move step up", onclick: () => moveStep(step.id, -1) }, "↑"),
      h("button", { type: "button", class: "button secondary small", disabled: index === state.steps.length - 1, "aria-label": "Move step down", onclick: () => moveStep(step.id, 1) }, "↓"),
      h("button", { type: "button", class: "button secondary small", onclick: () => removeStep(step.id) }, "Delete"),
    ),
  );
}

function field(kind, label, input) {
  const id = `field-${kind}`;
  input.id = id;
  return h("div", { class: `field ${kind}` }, h("label", { for: id }, label), input);
}

function renderResults() {
  const sections = [runSection()];
  if (state.selected !== INPUT) sections.push(stepSection(stepById(state.selected)));
  $("#results").replaceChildren(h("div", { class: "results" }, ...sections));
}

function runSection() {
  const run = state.run;
  const children = [h("h2", { class: "overline" }, "Run")];

  if (!state.runId && !state.runError) {
    children.push(h("p", { class: "empty" }, "Press Run to start the pipeline as a workflow task run."));
    return h("section", { class: "result-section" }, ...children);
  }

  if (run) {
    const status = runStatusChip(run);
    children.push(
      h(
        "dl",
        { class: "facts" },
        h("dt", {}, "Status"),
        h("dd", {}, chip(status)),
        h("dt", {}, "Task run"),
        h("dd", { class: "mono" }, run.id),
        ...(run.startedAt && run.completedAt
          ? [h("dt", {}, "Duration"), h("dd", {}, seconds(Date.parse(run.completedAt) - Date.parse(run.startedAt)))]
          : []),
      ),
    );
    if (run.error) children.push(h("div", { class: "error-box" }, run.error));
    if (run.result?.ok) children.push(codeBlock("Output", run.result.output));
  }
  if (state.runError) children.push(h("div", { class: "error-box" }, state.runError));

  return h("section", { class: "result-section" }, ...children);
}

function runStatusChip(run) {
  if (run.status === "pending") return { label: "Queued", tone: "neutral" };
  if (run.status === "running") return { label: "Running", tone: "neutral", busy: true };
  if (run.status === "canceled") return { label: "Canceled", tone: "neutral" };
  if (run.status === "failed" || run.result?.ok === false) return { label: "Failed", tone: "error" };
  return { label: "Succeeded", tone: "success" };
}

function stepSection(step) {
  const status = stepState(step);
  const children = [h("h2", { class: "overline" }, step.name || "Step")];

  if (!status?.view) {
    const text = status
      ? `${status.label}.`
      : "This step hasn't run yet. Its result, console output, and sandbox details appear here.";
    children.push(h("p", { class: "empty" }, text));
    return h("section", { class: "result-section" }, ...children);
  }

  const { view } = status;
  const result = view.result;
  const facts = [h("dt", {}, "Status"), h("dd", {}, chip(status))];
  if (result) {
    facts.push(h("dt", {}, "Sandbox"), h("dd", { class: "mono" }, result.sandboxId));
    facts.push(h("dt", {}, "Duration"), h("dd", {}, seconds(result.durationMs)));
  }
  facts.push(h("dt", {}, "Task run"), h("dd", { class: "mono" }, view.taskRunId));
  if (view.attempts > 1) facts.push(h("dt", {}, "Attempts"), h("dd", {}, String(view.attempts)));
  children.push(h("dl", { class: "facts" }, ...facts));

  const error = result?.error ?? view.error;
  if (error) children.push(h("div", { class: "error-box" }, error));
  if (result?.ok) children.push(codeBlock("Output", result.output));
  if (result) children.push(codeBlock("Console", result.logs || "(no output)", false));

  return h("section", { class: "result-section" }, ...children);
}

function codeBlock(label, value, asJson = true) {
  const text = asJson ? JSON.stringify(value, null, 2) ?? "null" : value;
  return h("div", { class: "block" }, h("h3", { class: "overline" }, label), h("pre", { class: "code" }, text));
}

function renderRunControls() {
  const running = isRunning();
  $("#run").disabled = state.starting || running || state.steps.length === 0;
  $("#run").textContent = state.starting ? "Starting…" : running ? "Running…" : "Run pipeline";
  $("#cancel").hidden = !running || !state.runId;

  const error = state.runError ?? state.notice;
  if (error) return setRunStatus(error, true);
  const run = state.run;
  if (!run) return setRunStatus(state.starting ? "Starting workflow…" : "");

  const done = state.steps.filter((step) => stepState(step)?.tone === "success").length;
  const label = runStatusChip(run).label;
  setRunStatus(`${label} · ${done} of ${state.steps.length} steps succeeded`);
}

function setRunStatus(text, isError = false) {
  const el = $("#run-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// --- Helpers ----------------------------------------------------------------------------------

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function fetchJson(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed with ${res.status}`);
  return data;
}

/** Creates an element. Text children are set with textContent, so user output is never parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else if (value === false || value == null) continue;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === "" || child == null) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}
