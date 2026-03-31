/**
 * v3-runtime.ts
 *
 * The v3 execution engine. Extends v2 with:
 *   - Real validation execution (no more DEFERRED)
 *   - Doom loop detection (Phase B)
 *   - Ralph loop (fresh context retry) (Phase B)
 *   - Filesystem collaboration (Phase B)
 *   - Execution traces (Phase D)
 *   - Context compaction (Phase C)
 *   - Reasoning sandwich model routing (Phase C)
 *
 * Principle: The Squad Manager IS the runtime.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import type {
  SquadWorkflow, V2WorkflowStep, ModelStrategy, ParsedSquad, HarnessConfig
} from "./squad-parser.js";

// ─── State Types ─────────────────────────────────────────────

export interface RunState {
  run_id: string;
  squad: string;
  workflow: string;
  version: string;
  status: "running" | "completed" | "failed" | "paused";
  started_at: string;
  finished_at: string | null;
  duration: string | null;
  current_step: number;
  last_completed: number | null;
  total_steps: number;
  steps: StepState[];
  error: string | null;
  // v3
  harness_active: boolean;
  harness_config: HarnessConfig | null;
}

export interface StepState {
  step: number;
  type: "agent" | "human-gate";
  agent?: string;
  id?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  started_at: string | null;
  finished_at: string | null;
  duration: string | null;
  checkpoint: string | null;
  validation?: {
    schema: "PASS" | "FAIL" | "SKIP";
    assertions: ("PASS" | "FAIL")[];
    retries: number;
    errors?: string[];
    duration_ms?: number;
  };
  error?: string;
}

export interface StepCheckpoint {
  step: number;
  agent: string;
  output: any;
  output_format: string;
  artifact_path: string | null;
  validation_result: {
    schema: string;
    assertions_passed: number;
    assertions_total: number;
    errors?: string[];
  } | null;
  timestamp: string;
}

// ─── State Management ────────────────────────────────────────

export function stateDir(cwd: string, runId: string): string {
  return join(cwd, ".squad-state", runId);
}

export function artifactsDir(cwd: string, runId: string): string {
  return join(stateDir(cwd, runId), "artifacts");
}

export function createRunState(
  cwd: string,
  runId: string,
  squad: string,
  workflowName: string,
  version: string,
  totalSteps: number,
  steps: V2WorkflowStep[],
  harnessConfig: HarnessConfig | null
): RunState {
  const dir = stateDir(cwd, runId);
  mkdirSync(dir, { recursive: true });

  const state: RunState = {
    run_id: runId,
    squad,
    workflow: workflowName,
    version,
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null,
    duration: null,
    current_step: 0,
    last_completed: null,
    total_steps: totalSteps,
    steps: steps.map((s, i) => ({
      step: i,
      type: s.type,
      agent: s.agent,
      id: s.id,
      status: "pending",
      started_at: null,
      finished_at: null,
      duration: null,
      checkpoint: null,
    })),
    error: null,
    harness_active: harnessConfig !== null,
    harness_config: harnessConfig,
  };

  writeRunState(cwd, runId, state);
  return state;
}

export function readRunState(cwd: string, runId: string): RunState | null {
  const path = join(stateDir(cwd, runId), "state.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeRunState(cwd: string, runId: string, state: RunState): void {
  const path = join(stateDir(cwd, runId), "state.json");
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

export function saveCheckpoint(
  cwd: string,
  runId: string,
  stepIndex: number,
  agent: string,
  output: any,
  format: string,
  artifactPath: string | null,
  validationResult: import("./validation.js").ValidationResult | null
): string {
  const filename = `step-${String(stepIndex).padStart(3, "0")}-${agent}.json`;
  const checkpoint: StepCheckpoint = {
    step: stepIndex,
    agent,
    output,
    output_format: format,
    artifact_path: artifactPath,
    validation_result: validationResult ? {
      schema: validationResult.schema_result,
      assertions_passed: validationResult.assertion_results.filter(a => a.result === "PASS").length,
      assertions_total: validationResult.assertion_results.length,
      errors: validationResult.schema_errors.length > 0 ? validationResult.schema_errors : undefined,
    } : null,
    timestamp: new Date().toISOString(),
  };

  const path = join(stateDir(cwd, runId), filename);
  writeFileSync(path, JSON.stringify(checkpoint, null, 2), "utf8");
  return filename;
}

export function loadCheckpoint(cwd: string, runId: string, filename: string): StepCheckpoint | null {
  const path = join(stateDir(cwd, runId), filename);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function saveHumanGateResponse(
  cwd: string,
  runId: string,
  gateId: string,
  responses: Record<string, any>
): string {
  const filename = `human-gate-${gateId}.json`;
  const path = join(stateDir(cwd, runId), filename);
  writeFileSync(path, JSON.stringify({ gate_id: gateId, responses, timestamp: new Date().toISOString() }, null, 2), "utf8");
  return filename;
}

// ─── Artifact Persistence (v3: Filesystem Collaboration) ─────

export function saveArtifact(
  cwd: string,
  runId: string,
  name: string,
  content: string,
  format: string = "text"
): string {
  const dir = artifactsDir(cwd, runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

export function listArtifacts(
  cwd: string,
  runId: string
): { name: string; path: string; size: number }[] {
  const dir = artifactsDir(cwd, runId);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).map(name => {
      const path = join(dir, name);
      const stat = readFileSync(path);
      return { name, path, size: stat.length };
    });
  } catch {
    return [];
  }
}

// ─── Finalization ────────────────────────────────────────────

export function finalizeRun(cwd: string, runId: string, status: "completed" | "failed", error?: string): void {
  const state = readRunState(cwd, runId);
  if (!state) return;

  state.status = status;
  state.finished_at = new Date().toISOString();
  state.duration = formatDuration(new Date(state.started_at), new Date(state.finished_at));
  if (error) state.error = error;

  writeRunState(cwd, runId, state);
}

function formatDuration(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${s}s`;
}

// ─── Model Resolution (v3: Reasoning Sandwich) ───────────────

/**
 * Resolve model for a step. Priority:
 *   1. Agent-level model (from agent .md frontmatter)
 *   2. Step-level model (from workflow step)
 *   3. Phase-based routing (v3: planning→orchestrator, impl→workers, verify→reviewers)
 *   4. Workflow-level model_strategy
 *   5. Squad-level model_strategy
 *   6. undefined (use platform default)
 */
export function resolveModel(
  step: V2WorkflowStep,
  agentModel: string,
  workflowStrategy: ModelStrategy | null,
  squadStrategy: ModelStrategy | null,
  isOrchestrator: boolean,
  isReviewer: boolean
): string | undefined {
  // 1. Agent-level
  if (agentModel) return agentModel;

  // 2. Step-level
  if (step.model) return step.model;

  // 3. Phase-based (v3 reasoning sandwich)
  const strategy = workflowStrategy || squadStrategy;
  if (step.phase && strategy) {
    if (step.phase === "planning" && strategy.orchestrator) return strategy.orchestrator;
    if (step.phase === "implementation" && strategy.workers) return strategy.workers;
    if (step.phase === "verification" && strategy.reviewers) return strategy.reviewers;
  }

  // 4/5. Strategy-based (v2 compat)
  if (!strategy) return undefined;
  if (!strategy.override && agentModel) return agentModel;

  if (isOrchestrator && strategy.orchestrator) return strategy.orchestrator;
  if (isReviewer && strategy.reviewers) return strategy.reviewers;
  if (strategy.workers) return strategy.workers;

  return undefined;
}

// ─── Handoff Formatting ──────────────────────────────────────

export type InjectAs = "structured" | "file_ref" | "summary" | "full";

export function formatHandoff(
  output: string,
  injectAs: InjectAs,
  artifactPath: string | null,
  contextBudget: number
): string {
  switch (injectAs) {
    case "structured":
      return contextBudget > 0 && output.length > contextBudget * 4
        ? output.slice(0, contextBudget * 4) + "\n[... truncated for context budget ...]"
        : output;

    case "file_ref":
      return artifactPath
        ? `[Artifact saved to: ${artifactPath}. Use the read tool to access it.]`
        : `[Output available inline — no file path specified]`;

    case "summary":
      const summaryLen = Math.min(1500, contextBudget > 0 ? contextBudget * 4 : 1500);
      return output.length > summaryLen
        ? output.slice(0, summaryLen) + `\n[... summary truncated. Full output: ${output.length} chars.]`
        : output;

    case "full":
    default:
      return output;
  }
}

// ─── Context Compaction (v3) ─────────────────────────────────

export function compactHandoff(
  output: string,
  config: { strategy: string; max_handoff_tokens: number; preserve_schema_fields?: boolean },
  schemaPath?: string
): string {
  const estimatedTokens = output.length / 4;
  if (estimatedTokens <= config.max_handoff_tokens) return output;

  switch (config.strategy) {
    case "truncate":
      return output.slice(0, config.max_handoff_tokens * 4) + "\n[... truncated for context budget ...]";

    case "key-fields": {
      // Parse JSON, keep only schema-required fields
      try {
        const { extractJson } = require("./validation.js");
        const json = extractJson(output);
        if (json && schemaPath && existsSync(schemaPath)) {
          const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
          const required = schema.required || Object.keys(schema.properties || {});
          const filtered: any = {};
          for (const key of required) {
            if (key in json) filtered[key] = json[key];
          }
          return JSON.stringify(filtered, null, 2);
        }
      } catch {
        // Fallback to truncate
      }
      return output.slice(0, config.max_handoff_tokens * 4) + "\n[... truncated ...]";
    }

    case "summarize":
      return `[SUMMARY — original: ${output.length} chars]\n` +
        output.slice(0, 2000) + "\n[... request Squad Manager to summarize ...]";

    default:
      return output;
  }
}

// ─── Template Engine ─────────────────────────────────────────

export function fillTemplate(template: string, data: Record<string, any>): string {
  let result = template;

  result = result.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/g, (_, field) => {
    const parts = field.split(".");
    let value: any = data;
    for (const part of parts) {
      if (value == null) return `{{${field}}}`;
      value = value[part];
    }
    return value != null ? String(value) : `{{${field}}}`;
  });

  result = result.replace(
    /\{\{#each\s+([a-zA-Z_][a-zA-Z0-9_.]*)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_, arrayField, block) => {
      const parts = arrayField.split(".");
      let arr: any = data;
      for (const part of parts) {
        if (arr == null) return "";
        arr = arr[part];
      }
      if (!Array.isArray(arr)) return "";
      return arr.map((item: any) => {
        return block.replace(/\{\{this\.([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/g, (_: any, f: string) => {
          return item?.[f] != null ? String(item[f]) : "";
        }).replace(/\{\{this\}\}/g, String(item));
      }).join("");
    }
  );

  return result;
}

// ─── Trigger Emission ────────────────────────────────────────

export type TriggerEvent =
  | "squad-start" | "flow-transition" | "flow-complete"
  | "validation-pass" | "validation-fail"
  | "checkpoint-saved"
  | "human-gate-start" | "human-gate-complete"
  | "workflow-resumed"
  | "model-routed"
  // v3 events
  | "doom-loop-detected"
  | "ralph-loop-retry"
  | "artifact-saved"
  | "context-compacted"
  | "trace-recorded";

export function buildTrigger(type: TriggerEvent, payload: Record<string, any>): string {
  return `<!-- squad:event ${JSON.stringify({ type, ...payload })} -->`;
}

// ─── Resume Support ──────────────────────────────────────────

export interface ResumeInfo {
  canResume: boolean;
  reason: string;
  startFromStep: number;
  previousOutputs: Map<number, string>;
}

export function getResumeInfo(cwd: string, runId: string): ResumeInfo {
  const state = readRunState(cwd, runId);
  if (!state) {
    return { canResume: false, reason: "No state found for this run.", startFromStep: 0, previousOutputs: new Map() };
  }

  if (state.status === "completed") {
    return { canResume: false, reason: "Run already completed.", startFromStep: 0, previousOutputs: new Map() };
  }

  if (state.status === "running") {
    return { canResume: false, reason: "Run appears to still be running.", startFromStep: 0, previousOutputs: new Map() };
  }

  const startFrom = (state.last_completed ?? -1) + 1;
  const previousOutputs = new Map<number, string>();
  for (const step of state.steps) {
    if (step.status === "completed" && step.checkpoint) {
      const cp = loadCheckpoint(cwd, runId, step.checkpoint);
      if (cp) {
        previousOutputs.set(step.step, typeof cp.output === "string" ? cp.output : JSON.stringify(cp.output));
      }
    }
  }

  return {
    canResume: true,
    reason: `Resuming from step ${startFrom} (${state.steps[startFrom]?.agent || state.steps[startFrom]?.id || "unknown"})`,
    startFromStep: startFrom,
    previousOutputs,
  };
}

// ─── Run Listing ─────────────────────────────────────────────

export function listRuns(cwd: string, squadName?: string): RunState[] {
  const baseDir = join(cwd, ".squad-state");
  if (!existsSync(baseDir)) return [];

  try {
    const entries = readdirSync(baseDir);
    const runs: RunState[] = [];

    for (const entry of entries) {
      const statePath = join(baseDir, entry, "state.json");
      if (!existsSync(statePath)) continue;
      try {
        const state: RunState = JSON.parse(readFileSync(statePath, "utf8"));
        if (!squadName || state.squad === squadName) {
          runs.push(state);
        }
      } catch { /* skip */ }
    }

    return runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
  } catch {
    return [];
  }
}
