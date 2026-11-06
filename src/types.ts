export interface CodeBlock {
  /** TypeScript source written by the end user. Must default-export a function of the block's input. */
  code: string;
  /** HTTPS hosts the block may call. Empty means no outbound network at all. */
  allowedDomains?: string[];
  /** Wall-clock limit for the user's code. */
  timeoutSeconds?: number;
}

export interface BlockResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  logs: string;
  timedOut: boolean;
  sandboxId: string;
  durationMs: number;
}

export interface HarnessResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

/** One step of a pipeline: a code block plus the id and name the editor tracks it by. */
export interface PipelineStep extends CodeBlock {
  id: string;
  name: string;
}

export interface Pipeline {
  /** Input to the first step. Every later step receives the previous step's output. */
  input: unknown;
  steps: PipelineStep[];
}

export interface PipelineResult {
  ok: boolean;
  /** The last step's output, when every step succeeded. */
  output?: unknown;
  /** The step that stopped the pipeline, when one failed. */
  failedStepId?: string;
  steps: { stepId: string; result: BlockResult }[];
}
