// The Render Workflow behind the editor. `runPipeline` runs the steps in order, and each step is
// its own `runBlock` task run with its own sandbox, so progress is visible one step at a time.
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { runCodeBlock } from "./runCodeBlock.ts";
import type { BlockResult, Pipeline, PipelineResult, PipelineStep } from "./types.ts";

// runCodeBlock throws only on infrastructure errors (create, boot, upload), and Workflows retries
// those. A block that throws or times out comes back as ok: false and isn't retried, because the
// same code would fail the same way.
export const runBlock = task(
  {
    name: "runBlock",
    plan: "starter",
    timeoutSeconds: 300,
    retry: { maxRetries: 2, waitDurationMs: 2000 },
  },
  async function runBlock(
    _ctx: TaskContext,
    step: PipelineStep,
    input: unknown,
  ): Promise<BlockResult> {
    return runCodeBlock(step, input);
  },
);

export const runPipeline = task(
  { name: "runPipeline", plan: "starter", timeoutSeconds: 3600 },
  async function runPipeline(ctx: TaskContext, pipeline: Pipeline): Promise<PipelineResult> {
    const steps: PipelineResult["steps"] = [];
    let input = pipeline.input;

    for (const step of pipeline.steps) {
      const result = await ctx.run(runBlock, step, input);
      steps.push({ stepId: step.id, result });
      if (!result.ok) return { ok: false, failedStepId: step.id, steps };
      input = result.output;
    }

    return { ok: true, output: input, steps };
  },
);
