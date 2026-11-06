# Run user-written TypeScript in Render Sandboxes

A minimal pattern for running end-user code inside a workflow builder. Each code block in your builder runs in its own Render Sandbox, a Firecracker microVM. Your workflow engine stays where it is. Where you would have called `node:vm`, call `runCodeBlock()`.

```
Workflow engine (your backend: holds the Render API key)
   │  runCodeBlock({ code, allowedDomains }, input)
   ▼
One sandbox per run (microVM, from the "v5-ts-runner" snapshot)
   ├─ network: deny-all, or only its allowedDomains (HTTPS)
   ├─ credentials: brokered outside the VM, never visible to user code
   └─ user code + input.json → harness → output.json
   │
   ▼  output, logs, timedOut → terminated
```

## What's here

| Path | Purpose |
| --- | --- |
| `src/runCodeBlock.ts` | The request-time lifecycle: create, boot, upload, execute, download, and terminate. |
| `src/harness.mts` | Runs inside the sandbox: loads the user code, calls it, writes `output.json`. |
| `src/setup.ts` | One-time setup: installs `tsx` and the libraries user code can import (`zod`, `axios`) in a sandbox and saves it as a snapshot. |
| `src/runnerConfig.ts` | Snapshot contents, sandbox paths, and the command used to invoke the harness. |
| `src/sandboxUtilities.ts` | Shared SDK client, network-policy construction, and polling delay. |
| `src/types.ts` | The public code-block request and result types. |
| `src/demo.ts` | A short table of contents that runs each learning-area chapter. |
| `src/demo/` | One focused chapter per concept, plus shared reporting helpers. |
| `src/workflow.ts` | A Render Workflow that runs a pipeline of code blocks, one sandbox per step. |
| `src/server.ts` | The pipeline editor's backend: starts workflow runs and reports each step's progress. |
| `web/` | The pipeline editor: a Monaco code editor for each step, with run status, output, and logs. |
| `render.yaml` | Blueprint that deploys the workflow and the editor's web service. |
| `examples/` | Sample user code: four well-behaved examples, one that uses a brokered credential, and five hostile ones. |

## Run it

Requires Node 22.9+ and a workspace with Sandboxes enabled.

```bash
cp .env.example .env      # add RENDER_API_KEY and RENDER_WORKSPACE_ID
npm install
npm run setup             # builds the runner snapshot, about a minute
npm run demo
```

The demo:

1. **Runs several examples in parallel, each in its own sandbox:**
   - a pure transform with no network access;
   - a `fetch` call to `api.github.com`, the only domain on its allowlist;
   - the same call made with axios, with input and response validated by zod;
   - the zod example again with invalid input, to show how a validation error comes back.
2. **Blocks requests to hosts outside the sandbox's network allowlist.**
3. **Stops an infinite loop at its wall-clock time limit.**
4. **Runs hostile code and confirms each attempt is contained:**
   - dumping the environment finds no secrets;
   - a `node:vm` escape lands in a disposable VM with none of the host's files;
   - `rm -rf /` destroys only its own sandbox.
5. **Runs a well-behaved example again** to show the next run still gets a clean sandbox.
6. **Calls OpenAI with no key in the code or its environment.** The credential broker adds the key as matching requests leave the sandbox. This needs one-time setup (see below).

For a code walkthrough, start with `src/runCodeBlock.ts`. Its numbered sections deliberately
leave every important Sandbox SDK call visible. Read `src/harness.mts` next to see the trusted
boundary around user code, then `src/setup.ts` to see how the reusable filesystem snapshot is built.

## Pipeline editor

A web editor for building a pipeline of code blocks and running it as a Render Workflow. Each
step runs in its own sandbox and receives the previous step's output.

```
Browser: one Monaco editor per step                          web/
   │  POST /api/runs { input, steps }
   ▼
Web server (holds the Render API key)                        src/server.ts
   │  workflows.startTask("<workflow-slug>/runPipeline", [pipeline])
   ▼
runPipeline task: runs the steps in order                    src/workflow.ts
   │  ctx.run(runBlock, step, previousOutput)
   ▼
runBlock task, one task run per step → runCodeBlock() → one sandbox
```

The editor polls the run and shows which step is running, then each step's output, console
output, sandbox ID, and errors. A failed or timed-out step stops the pipeline. `runBlock` retries
infrastructure errors, such as a sandbox that fails to boot, up to twice. It doesn't retry errors
in user code, because the same code would fail the same way.

### Run it locally

Build the runner snapshot first (`npm run setup`) if you haven't. Then, in two terminals:

```bash
npm run workflow:dev      # local task server on :8120, runs src/workflow.ts
npm run web:dev           # editor on http://localhost:3000
```

The tasks run on your machine, but each step still creates a real sandbox, so `.env` needs
`RENDER_API_KEY` and `RENDER_WORKSPACE_ID`. `web:dev` sets `RENDER_USE_LOCAL_DEV=true` so the web
server starts runs on the local task server. Don't put that variable in `.env`: the task process
loads `.env` too, and the SDK would then send its sandbox calls to localhost.

### Deploy to Render

[`render.yaml`](render.yaml) is a Blueprint that creates both services:

| Service | Type | Start command |
| --- | --- | --- |
| `sandbox-pipeline` | Workflow | `npm run workflow`: registers the `runPipeline` and `runBlock` tasks |
| `sandbox-pipeline-editor` | Web service (Starter) | `npm run web`: serves the editor and its API |

1. Build the runner snapshot in the same workspace, if you haven't: `npm run setup`.
2. Push this repo to GitHub, GitLab, or Bitbucket.
3. In the Dashboard, click **New > Blueprint** and select the repo.
4. When prompted, enter `RENDER_API_KEY` and `RENDER_WORKSPACE_ID`. Both services read them from
   the `sandbox-pipeline-api` environment group.

The web service reads `WORKFLOW_SLUG` from the workflow (`fromService` with `property: slug`), so
it always starts runs on the workflow the Blueprint created. Workflows have no service plan:
`src/workflow.ts` sets each task's compute plan.

The web server has no authentication. Anyone who can reach it can run code in your sandboxes, so
put it behind your own auth before you expose it. It does enforce limits on what it starts: 10
steps, 60 seconds per step, 100,000 characters of code per step, and hostnames only in each
step's allowlist.

If you cancel a run partway through a step, that step's `finally` block may not run. The sandbox
then stops when it reaches the `timeoutSeconds` it was created with: the step's time limit plus
120 seconds.

## Writing user code

User code is a TypeScript module that default-exports a function of its input. The function can be async, and its return value must be JSON-serializable.

```ts
import axios from "axios";
import { z } from "zod";

const Input = z.object({ repo: z.string() });

export default async function (input: unknown) {
  const { repo } = Input.parse(input);
  const { data } = await axios.get(`https://api.github.com/repos/${repo}`);
  return { stars: data.stargazers_count };
}
```

- **Imports:** Node built-ins plus the libraries preinstalled in the snapshot, currently `zod` and `axios`. User code can't install packages itself, because its sandbox can't reach the npm registry.
- **Adding a library:** add it to `RUNNER_PACKAGES` in `src/runnerConfig.ts`, then rerun `npm run setup`.
- **Errors:** if the code throws, including on a failed zod `parse`, the result has `ok: false` and the error message.

In your builder:

```ts
const result = await runCodeBlock(
  { code: userCode, allowedDomains: ["api.github.com"], timeoutSeconds: 10 },
  previousStepOutput,
);
if (!result.ok) failStep(result.error, result.logs);
```

## Credential brokering

Brokered credentials are configured on the sandbox group, not per sandbox. Every sandbox in the group inherits the same rules. Brokering is in early access, so ask your Render contact to enable it for your workspace.

To configure the rule the demo expects, open your sandbox group in the Render Dashboard, go to **Environment → Brokered credentials**, and add:

| Field | Value |
| --- | --- |
| Key | `OPENAI_API_KEY` |
| Preset | OpenAI (`api.openai.com`, `Authorization: Bearer`) |
| Allowed requests | `GET`, path exactly `/v1/models` |
| Unmatched requests | Deny (the default) |

Then set `DEMO_BROKERING=1` in `.env` and rerun the demo. The example gets `200` from `/v1/models` and is denied on `/v1/files`.

Two rules apply:

- **A credential doesn't grant network access.** The brokered host must also be in `allowedDomains`.
- **Credentials apply to the whole group.** Use them for credentials your platform owns. Brokering each end user's own keys separately needs multiple sandbox groups or per-sandbox credential selection. Neither is available yet.

## Rules this code follows

- **No Render API key in the sandbox.** Anything the sandbox can reach, user code can reach.
- **Pass a network policy on every create.** A sandbox restored from a snapshot without an explicit policy comes up with no working egress.
- **Enforce the time limit inside the sandbox** with `timeout`. Aborting `exec` from the SDK doesn't stop the remote process.
- **Return output through a file, not stdout,** so `console.log` output from user code stays in `logs`.
- **Always terminate in `finally`.** `timeoutSeconds` on create is only a backstop.

## Limits to know

- **SDK version.** Sandboxes are under `render.experimental.sandboxes` in `@renderinc/sdk` 1.4.0. Expect the namespace to move at GA.
- **Allowlists are HTTPS only,** with wildcards only in the leftmost label. A sandbox's policy can't change after creation.
- **Rate limits.** Each run makes about 10 API calls (create, status polls, two uploads, exec, download, terminate), and every exec and file operation counts against the API rate limit. A production implementation should retry safe operations after transient errors and `429` responses; this demo leaves that policy out so the execution lifecycle stays visible.
- **Snapshot expiry.** The runner snapshot expires after Render's default lifetime, 30 days at the time of writing. Rerun `npm run setup` before then, or schedule it as a cron job.
