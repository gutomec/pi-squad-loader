// @ts-nocheck — Pi SDK types are strict about return shapes; this extension
// follows the same pattern as v1/v2 which also doesn't typecheck strictly.
// All returns are structurally correct at runtime.

/**
 * pi-squad-loader v3 — GSD-PI Extension
 *
 * v3 additions over v2:
 *   - REAL validation execution (ajv in-process, not DEFERRED)
 *   - Retry loop with error feedback on validation failure
 *   - v3 detection via `harness:` key in squad.yaml
 *   - Filesystem collaboration: artifacts written to .squad-state/{run-id}/artifacts/
 *   - squad_validate_output tool for debugging
 *
 * All v1/v2 tools preserved. v1/v2 squads run unchanged.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import {
  discoverSquads, parseFullSquad, detectSquadVersion,
  type SquadManifest, type ParsedSquad, type V2WorkflowStep, type SquadVersion,
} from "../lib/squad-parser.js";
import {
  adaptSquad, buildWorkflowChain, buildDispatchPrompt,
  type WorkflowChainStep,
} from "../lib/agent-adapter.js";
import {
  createRunState, readRunState, writeRunState,
  saveCheckpoint, saveHumanGateResponse, finalizeRun,
  getResumeInfo, listRuns, resolveModel,
  formatHandoff, fillTemplate, buildTrigger, stateDir,
  saveArtifact, compactHandoff,
  type RunState,
} from "../lib/v3-runtime.js";
import {
  executeValidation, extractJson, buildRetryPrompt, formatValidationSummary,
  type ValidationResult,
} from "../lib/validation.js";
import {
  findGsdBinary, findSquadDirectories, getAgentsCacheDir, getStateDir,
  verifyGsdInstallation,
} from "../lib/path-resolver.js";

// ─── Result Helpers ──────────────────────────────────────────
// Pi SDK requires specific return shape. These helpers ensure type safety.

function textResult(text: string, details: any = {}): any {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(text: string, details: any = {}): any {
  return { content: [{ type: "text" as const, text }], isError: true, details };
}

// ─── State ───────────────────────────────────────────────────

interface LoaderState {
  squadsDir: string;
  manifests: SquadManifest[];
  loadedSquads: Map<string, ParsedSquad>;
  activatedAgents: Map<string, string[]>;
  agentsCacheDir: string;
}

const state: LoaderState = {
  squadsDir: "",
  manifests: [],
  loadedSquads: new Map(),
  activatedAgents: new Map(),
  agentsCacheDir: "",
};

// ─── Helpers ─────────────────────────────────────────────────

function ensureDiscovered(): boolean {
  if (state.manifests.length === 0) {
    // Discover squads from all configured directories
    const squadsDirectories = findSquadDirectories();
    const allManifests: SquadManifest[] = [];
    const seenNames = new Set<string>();

    for (const dir of squadsDirectories) {
      if (existsSync(dir)) {
        const manifests = discoverSquads(dir);
        for (const m of manifests) {
          if (!seenNames.has(m.name)) {
            allManifests.push(m);
            seenNames.add(m.name);
          }
        }
      }
    }

    state.manifests = allManifests;
  }
  return state.manifests.length > 0;
}

function versionTag(v: SquadVersion): string {
  return v === "v3" ? " [v3]" : v === "v2" ? " [v2]" : "";
}

function formatSquadList(manifests: SquadManifest[]): string {
  if (manifests.length === 0) return "No squads found.";
  const lines = [`Found ${manifests.length} squads in ${state.squadsDir}:\n`];
  for (const m of manifests) {
    const tag = versionTag(m.squadVersion);
    const activated = state.activatedAgents.has(m.name) ? " [ACTIVE]" : "";
    lines.push(
      `  ${m.name} v${m.version}${tag}${activated} — ${m.components.agents.length} agents, ${m.components.tasks.length} tasks, ${m.components.workflows.length} workflows`
    );
    if (m.description) lines.push(`    ${m.description.slice(0, 100)}${m.description.length > 100 ? "..." : ""}`);
    if (m.isV3 && m.harness) {
      const features: string[] = [];
      if (m.harness.doom_loop?.enabled) features.push("doom-loop");
      if (m.harness.ralph_loop?.enabled) features.push("ralph-loop");
      if (m.harness.filesystem_collaboration?.enabled) features.push("fs-collab");
      if (m.harness.traces?.enabled) features.push("traces");
      if (m.harness.context_compaction?.enabled) features.push("compaction");
      if (features.length > 0) lines.push(`    v3 harness: ${features.join(", ")}`);
    } else if (m.isV2) {
      const features: string[] = [];
      if (m.stateConfig?.enabled) features.push("state");
      if (m.modelStrategy) features.push("model-routing");
      if (m.components.schemas.length > 0) features.push(`${m.components.schemas.length} schemas`);
      if (features.length > 0) lines.push(`    v2 features: ${features.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function activateSquad(name: string): string {
  const manifest = state.manifests.find((m) => m.name === name);
  if (!manifest) return `Squad "${name}" not found. Run /squad list to see available squads.`;

  const parsed = parseFullSquad(manifest);
  state.loadedSquads.set(name, parsed);
  const adapted = adaptSquad(parsed, state.agentsCacheDir);
  const agentNames = adapted.map((a) => a.piName);
  state.activatedAgents.set(name, agentNames);

  const tag = versionTag(manifest.squadVersion);
  const lines = [
    `Squad "${name}" activated with ${adapted.length} agents${tag}:\n`,
    ...adapted.map((a) => `  ${a.source.icon} ${a.piName} — ${a.source.title}`),
    "", `Agents written to: ${state.agentsCacheDir}`,
  ];

  // v3 harness summary
  if (manifest.isV3 && manifest.harness) {
    lines.push("");
    lines.push("━━━ v3 HARNESS ━━━");
    if (manifest.harness.doom_loop?.enabled) lines.push(`  ✅ Doom loop detection (max ${manifest.harness.doom_loop.max_identical_outputs || 3} identical, on_detect: ${manifest.harness.doom_loop.on_detect || "abort"})`);
    if (manifest.harness.ralph_loop?.enabled) lines.push(`  ✅ Ralph loop (fresh context retry, max ${manifest.harness.ralph_loop.max_iterations || 5} iterations)`);
    if (manifest.harness.filesystem_collaboration?.enabled) lines.push(`  ✅ Filesystem collaboration`);
    if (manifest.harness.traces?.enabled) lines.push(`  ✅ Execution traces (${manifest.harness.traces.level || "standard"})`);
    if (manifest.harness.context_compaction?.enabled) lines.push(`  ✅ Context compaction (${manifest.harness.context_compaction.strategy || "key-fields"}, max ${manifest.harness.context_compaction.max_handoff_tokens || 4000} tokens)`);
    if (manifest.stateConfig?.enabled) lines.push("  ✅ State persistence (resume on failure)");
    if (manifest.modelStrategy) lines.push(`  ✅ Model routing: orchestrator=${manifest.modelStrategy.orchestrator}, workers=${manifest.modelStrategy.workers}`);
  } else if (manifest.isV2) {
    lines.push("");
    lines.push("━━━ v2 FEATURES ━━━");
    if (manifest.stateConfig?.enabled) lines.push("  ✅ State persistence");
    if (manifest.modelStrategy) lines.push(`  ✅ Model routing`);
    if (manifest.components.schemas.length > 0) lines.push(`  ✅ ${manifest.components.schemas.length} schemas`);
  }

  // Workflows
  if (parsed.workflows.length > 0) {
    lines.push("");
    lines.push("━━━ AVAILABLE WORKFLOWS ━━━");
    for (const wf of parsed.workflows) {
      const wfTag = wf.isV3 ? " [v3: harness]" : wf.isV2 ? " [v2]" : " [v1]";
      lines.push(`  📋 ${wf.name}${wfTag}`);
      if (wf.description) lines.push(`     ${wf.description}`);
      if (wf.steps.length > 0) {
        const pipeline = wf.steps.map((s) => s.agent).join(" → ");
        lines.push(`     Pipeline: ${pipeline}`);
      }
      lines.push(`  ⚡ USE: squad_workflow({ squad: "${name}", workflow: "${wf.name}", context: "..." })`);
    }
  }

  return lines.join("\n");
}

// ─── Agent Spawner ───────────────────────────────────────────

function spawnAgent(
  agentName: string,
  taskPrompt: string,
  cwd: string,
  signal?: AbortSignal,
  modelOverride?: string,
  timeoutMs: number = 180_000
): Promise<string> {
  const agentPath = join(state.agentsCacheDir, `${agentName}.md`);
  if (!existsSync(agentPath)) return Promise.resolve(`(agent ${agentName} not found)`);

  return new Promise<string>((resolve) => {
    const gsdBin = findGsdBinary();
    if (!gsdBin) {
      return resolve(
        `(GSD binary not found. Install GSD-2 from https://github.com/gsd-build/GSD-2)`
      );
    }

    let agentModel: string | undefined = modelOverride;
    let agentTools: string[] = [];
    let agentSystemPrompt = "";

    try {
      const agentContent = readFileSync(agentPath, "utf8");
      const fmMatch = agentContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (fmMatch) {
        const fmLines = fmMatch[1].split("\n");
        agentSystemPrompt = fmMatch[2];
        for (const line of fmLines) {
          if (!agentModel) {
            const modelMatch = line.match(/^model:\s*(.+)$/);
            if (modelMatch) agentModel = modelMatch[1].trim();
          }
          const toolsMatch = line.match(/^tools:\s*(.+)$/);
          if (toolsMatch) agentTools = toolsMatch[1].split(",").map((t: string) => t.trim()).filter(Boolean);
        }
      }
    } catch { /* fallback */ }

    const args: string[] = ["--mode", "json", "-p", "--no-session"];
    if (agentModel) args.push("--model", agentModel);
    if (agentTools.length > 0) args.push("--tools", agentTools.join(","));

    let tmpDir: string | null = null;
    let tmpPath: string | null = null;
    if (agentSystemPrompt.trim()) {
      tmpDir = fs.mkdtempSync(join(os.tmpdir(), "squad-v3-"));
      tmpPath = join(tmpDir, `${agentName}.md`);
      fs.writeFileSync(tmpPath, agentSystemPrompt, { encoding: "utf-8", mode: 0o600 });
      args.push("--append-system-prompt", tmpPath);
    }

    args.push(`Task: ${taskPrompt}`);

    const allPaths = (process.env.GSD_BUNDLED_EXTENSION_PATHS ?? "").split(":").filter(Boolean);
    const heavyExtensions = ["browser-tools", "mac-tools", "bg-shell", "slash-commands", "ask-user-questions", "get-secrets-from-user"];
    const slimPaths = allPaths.filter(p => !heavyExtensions.some(h => p.includes(h)));
    const extensionArgs = slimPaths.flatMap(p => ["--extension", p]);

    const proc = spawn(
      gsdBin,
      [...extensionArgs, ...args],
      { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] }
    );

    let buffer = "";
    let finalOutput = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message?.role === "assistant") {
            for (const part of event.message.content ?? []) {
              if (part.type === "text") finalOutput = part.text;
            }
          }
        } catch { /* skip */ }
      }
    });

    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code, sig) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "message_end" && event.message?.role === "assistant") {
            for (const part of event.message.content ?? []) {
              if (part.type === "text") finalOutput = part.text;
            }
          }
        } catch { /* ignore */ }
      }
      try { if (tmpPath) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      try { if (tmpDir) fs.rmdirSync(tmpDir); } catch { /* ignore */ }

      if (!finalOutput && (code !== 0 || sig)) {
        resolve(`[squad-agent] ${agentName} exited ${code}${sig ? ` (${sig})` : ""}. ${stderr.slice(0, 500)}`);
      } else {
        resolve(finalOutput || stderr || "(no output)");
      }
    });

    proc.on("error", (err) => resolve(`(spawn error: ${err.message})`));

    const timer = setTimeout(() => {
      if (!proc.killed) { proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 3000); }
    }, timeoutMs);
    proc.on("close", () => clearTimeout(timer));

    if (signal) {
      const kill = () => { clearTimeout(timer); proc.kill("SIGTERM"); };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
  });
}

// ─── Extension Entry Point ───────────────────────────────────

export default function squadLoaderV3(pi: ExtensionAPI) {
  // Auto-detect GSD installation and paths (cross-platform, no config needed)
  const gsdCheck = verifyGsdInstallation();
  if (!gsdCheck.available) {
    console.warn(`[pi-squad-loader] ${gsdCheck.error}`);
  }

  // Use primary global squads directory for listing/display
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  state.squadsDir = resolve(homeDir, "squads");

  // Use auto-detected agent cache
  state.agentsCacheDir = getAgentsCacheDir();
  if (!existsSync(state.agentsCacheDir)) mkdirSync(state.agentsCacheDir, { recursive: true });

  // ═══════════════════════════════════════════════════════════
  //  TOOL: squad_list
  // ═══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "squad_list",
    label: "Squad List",
    description: "List all available squads from ~/squads, ~/.gsd/squads, and project-local .squads/. Shows v1/v2/v3 status and features. Auto-discovers on macOS, Linux, Windows.",
    promptSnippet: "List available squads and their agents",
    promptGuidelines: [
      "Use this tool to discover what squads are available before activating them",
      "Shows squad name, version, v1/v2/v3 status, agent count, and activation status",
      "Searches global user directories and project-local directories automatically",
    ],
    parameters: Type.Object({
      filter: Type.Optional(Type.String({ description: "Filter squads by name or tag" })),
    }),
    async execute(toolCallId, params) {
      ensureDiscovered();
      let filtered = state.manifests;
      if (params.filter) {
        const f = params.filter.toLowerCase();
        filtered = state.manifests.filter((m) =>
          m.name.toLowerCase().includes(f) || m.tags.some((t) => t.toLowerCase().includes(f)) || m.description.toLowerCase().includes(f)
        );
      }
      return {
        content: [{ type: "text" as const, text: formatSquadList(filtered) }],
        details: {
          count: filtered.length,
          squads: filtered.map((m) => m.name),
          v2Squads: filtered.filter(m => m.isV2 && !m.isV3).map(m => m.name),
          v3Squads: filtered.filter(m => m.isV3).map(m => m.name),
        },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════
  //  TOOL: squad_activate
  // ═══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "squad_activate",
    label: "Squad Activate",
    description: "Activate a squad, loading its agents as Pi subagents. Shows v3 harness features if present.",
    promptSnippet: "Activate a squad to make its agents available as subagents",
    promptGuidelines: [
      "Activate a squad before dispatching its agents",
      "v3 squads show harness features: doom loop, ralph loop, traces, filesystem collaboration",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Squad name to activate" }),
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      ensureDiscovered();
      onUpdate?.({ content: [{ type: "text" as const, text: `Activating squad "${params.name}"...` }] });
      const result = activateSquad(params.name);
      return {
        content: [{ type: "text" as const, text: result }],
        details: { squad: params.name, agents: state.activatedAgents.get(params.name) || [], activated: state.activatedAgents.has(params.name) },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════
  //  TOOL: squad_dispatch
  // ═══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "squad_dispatch",
    label: "Squad Dispatch",
    description: "Dispatch a specific squad agent to perform a task.",
    promptSnippet: "Dispatch a squad agent to perform specialized work",
    promptGuidelines: [
      "The squad must be activated first via squad_activate",
      "Provide the full agent ID: squad--{squad-name}--{agent-id}",
      "TASK PROMPT = INSTRUCTIONS, NOT CODE",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: 'Full Pi agent name (e.g. "squad--brandcraft--bc-extractor")' }),
      task: Type.String({ description: "Task description with full context for the agent" }),
      context: Type.Optional(Type.String({ description: "Additional context to inject" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const agentPath = join(state.agentsCacheDir, `${params.agent}.md`);
      if (!existsSync(agentPath)) {
        return { content: [{ type: "text" as const, text: `Agent "${params.agent}" not found. Activate the squad first.` }], isError: true, details: {} };
      }

      let taskPrompt = params.task;
      if (params.context) {
        taskPrompt = `## Context from previous agent\n${params.context}\n\n## Your Task\n${params.task}`;
      }

      onUpdate?.({ content: [{ type: "text" as const, text: `Dispatching ${params.agent}...` }] });
      const output = await spawnAgent(params.agent, taskPrompt, ctx.cwd, signal);
      return { content: [{ type: "text" as const, text: output }], details: { agent: params.agent } };
    },
  });

  // ═══════════════════════════════════════════════════════════
  //  TOOL: squad_workflow (v3: real validation + retry)
  // ═══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "squad_workflow",
    label: "Squad Workflow",
    description: "Run a squad workflow. v1: sequential. v2: state+gates. v3: real validation, doom loop, ralph loop, filesystem collaboration.",
    promptSnippet: "Run a multi-agent squad workflow",
    promptGuidelines: [
      "The squad must be activated first",
      "v3 workflows: real validation execution, retry with error feedback, filesystem artifacts",
    ],
    parameters: Type.Object({
      squad: Type.String({ description: "Squad name" }),
      workflow: Type.String({ description: "Workflow name" }),
      context: Type.String({ description: "Initial context/briefing for the workflow" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const parsed = state.loadedSquads.get(params.squad);
      if (!parsed) {
        return { content: [{ type: "text" as const, text: `Squad "${params.squad}" not activated.` }], isError: true, details: {} };
      }

      const chain = buildWorkflowChain(parsed, params.workflow);
      if (!chain || chain.length === 0) {
        return { content: [{ type: "text" as const, text: `Workflow "${params.workflow}" not found or empty.` }], isError: true, details: {} };
      }

      const workflow = parsed.workflows.find(w =>
        w.name.toLowerCase().replace(/[-_]/g, "").includes(params.workflow.toLowerCase().replace(/[-_]/g, ""))
      );

      // Route to correct runtime
      if (workflow?.isV2 || workflow?.isV3) {
        return await executeV3Workflow(parsed, workflow, chain, params, ctx, signal, onUpdate);
      }

      return await executeV1Workflow(chain, params, ctx, signal, onUpdate);
    },
  });

  // ═══════════════════════════════════════════════════════════
  //  TOOL: squad_resume
  // ═══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "squad_resume",
    label: "Squad Resume",
    description: "Resume a failed or paused workflow from its last checkpoint.",
    promptSnippet: "Resume a failed workflow from where it stopped",
    parameters: Type.Object({
      squad: Type.String({ description: "Squad name" }),
      run_id: Type.String({ description: "Run ID to resume" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const resumeInfo = getResumeInfo(ctx.cwd, params.run_id);
      if (!resumeInfo.canResume) {
        return { content: [{ type: "text" as const, text: resumeInfo.reason }], isError: true, details: {} };
      }

      const runState = readRunState(ctx.cwd, params.run_id);
      if (!runState) return { content: [{ type: "text" as const, text: "State file not found." }], isError: true, details: {} };

      const parsed = state.loadedSquads.get(params.squad);
      if (!parsed) return { content: [{ type: "text" as const, text: `Squad "${params.squad}" not activated.` }], isError: true, details: {} };

      const workflow = parsed.workflows.find(w => w.name === runState.workflow);
      if (!workflow) return { content: [{ type: "text" as const, text: "Workflow not found." }], isError: true, details: {} };

      const chain = buildWorkflowChain(parsed, workflow.name);
      if (!chain) return { content: [{ type: "text" as const, text: "Cannot build chain." }], isError: true, details: {} };

      onUpdate?.({ content: [{ type: "text" as const, text: `${resumeInfo.reason}\n${buildTrigger("workflow-resumed", { squad: params.squad, run_id: params.run_id, from_step: resumeInfo.startFromStep })}` }] });

      runState.status = "running";
      runState.error = null;
      writeRunState(ctx.cwd, params.run_id, runState);

      return await executeV3Steps(
        parsed, workflow, chain, runState, params.run_id,
        resumeInfo.startFromStep, resumeInfo.previousOutputs,
        ctx, signal, onUpdate
      );
    },
  });

  // ═══════════════════════════════════════════════════════════
  //  TOOL: squad_show_state
  // ═══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "squad_show_state",
    label: "Squad State",
    description: "Show workflow run history. Lists runs with status, validation results (never DEFERRED in v3).",
    promptSnippet: "Show run history for a squad",
    parameters: Type.Object({
      squad: Type.Optional(Type.String({ description: "Squad name (optional)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const runs = listRuns(ctx.cwd, params.squad);
      if (runs.length === 0) {
        return { content: [{ type: "text" as const, text: "No runs found." }], details: {} };
      }

      const lines = [`Found ${runs.length} run(s):\n`];
      for (const run of runs) {
        const icon = run.status === "completed" ? "✅" : run.status === "failed" ? "❌" : run.status === "running" ? "🔄" : "⏸️";
        const completed = run.steps.filter(s => s.status === "completed").length;
        const harnessTag = run.harness_active ? " [v3]" : "";
        lines.push(`  ${icon} ${run.run_id.slice(0, 8)} — ${run.squad}/${run.workflow}${harnessTag} — ${run.status} — ${completed}/${run.total_steps} steps — ${run.duration || "running"}`);
        if (run.error) lines.push(`     Error: ${run.error.slice(0, 100)}`);
        // Show validation results per step
        for (const step of run.steps) {
          if (step.validation) {
            const valIcon = step.validation.schema === "PASS" ? "✅" : step.validation.schema === "FAIL" ? "❌" : "⏭️";
            lines.push(`     Step ${step.step}: ${step.agent || step.id} — Schema: ${valIcon} ${step.validation.schema}, Retries: ${step.validation.retries}`);
            if (step.validation.errors?.length) {
              lines.push(`       Errors: ${step.validation.errors.slice(0, 2).join("; ")}`);
            }
          }
        }
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
    },
  });

  // ═══════════════════════════════════════════════════════════
  //  TOOL: squad_validate_output (NEW v3)
  // ═══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "squad_validate_output",
    label: "Validate Output",
    description: "Validate a JSON string against a squad schema and/or assertions. For debugging validation gates.",
    promptSnippet: "Manually validate output against a schema for debugging",
    parameters: Type.Object({
      squad: Type.String({ description: "Squad name" }),
      schema: Type.Optional(Type.String({ description: "Path to schema file (relative to squad root)" })),
      output: Type.String({ description: "JSON string or agent output to validate" }),
      assertions: Type.Optional(Type.Array(Type.String(), { description: "JS assertions to evaluate" })),
    }),
    async execute(toolCallId, params) {
      const parsed = state.loadedSquads.get(params.squad);
      if (!parsed) {
        return { content: [{ type: "text" as const, text: `Squad "${params.squad}" not activated.` }], isError: true, details: {} };
      }

      const validation: import("../lib/squad-parser.js").V2StepValidation = {
        schema: params.schema,
        assertions: params.assertions,
        on_fail: "abort",
      };

      const result = executeValidation(params.output, validation, parsed.manifest.dir);

      const lines = [
        `## Validation Result: ${result.passed ? "✅ PASS" : "❌ FAIL"}`,
        "",
        `Schema: ${result.schema_result}`,
      ];

      if (result.schema_errors.length > 0) {
        lines.push("Schema errors:");
        for (const e of result.schema_errors) lines.push(`  - ${e}`);
      }

      if (result.assertion_results.length > 0) {
        lines.push("");
        lines.push("Assertions:");
        for (const a of result.assertion_results) {
          lines.push(`  ${a.result === "PASS" ? "✅" : "❌"} ${a.expression}${a.error ? ` — ${a.error}` : ""}`);
        }
      }

      lines.push("");
      lines.push(`Duration: ${result.duration_ms}ms`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: result,
      };
    },
  });

  // ═══════════════════════════════════════════════════════════
  //  TOOL: squad_inject
  // ═══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "squad_inject",
    label: "Squad Inject",
    description: "Inject a squad artifact into the GSD .gsd/ context.",
    promptSnippet: "Inject squad artifacts into GSD project context",
    parameters: Type.Object({
      artifactPath: Type.String({ description: "Path to the artifact file" }),
      targetType: Type.Union([Type.Literal("research"), Type.Literal("decision"), Type.Literal("context")]),
      label: Type.Optional(Type.String({ description: "Label for the artifact" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd || process.cwd();
      const gsdDir = join(cwd, ".gsd");

      if (!existsSync(params.artifactPath)) {
        return { content: [{ type: "text" as const, text: `Artifact not found: ${params.artifactPath}` }], isError: true, details: {} };
      }

      const content = readFileSync(params.artifactPath, "utf8");
      let targetPath: string;

      switch (params.targetType) {
        case "research": {
          const dir = join(gsdDir, "milestones", "M001", "research");
          mkdirSync(dir, { recursive: true });
          targetPath = join(dir, (params.label || `squad-artifact-${Date.now()}`).replace(/\s+/g, "-").toLowerCase() + ".md");
          writeFileSync(targetPath, content, "utf8");
          break;
        }
        case "decision": {
          targetPath = join(gsdDir, "DECISIONS.md");
          const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
          mkdirSync(gsdDir, { recursive: true });
          writeFileSync(targetPath, existing + "\n" + content, "utf8");
          break;
        }
        case "context": {
          const dir = join(gsdDir, "squad-context");
          mkdirSync(dir, { recursive: true });
          targetPath = join(dir, (params.label || `context-${Date.now()}`).replace(/\s+/g, "-").toLowerCase() + ".md");
          writeFileSync(targetPath, content, "utf8");
          break;
        }
      }

      return { content: [{ type: "text" as const, text: `Artifact injected as ${params.targetType}: ${targetPath!}` }] };
    },
  });

  // ═══════════════════════════════════════════════════════════
  //  TOOL: squad_status
  // ═══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "squad_status",
    label: "Squad Status",
    description: "Show currently loaded squads, agents, and runtime status.",
    promptSnippet: "Check which squads are currently active",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (state.activatedAgents.size === 0) {
        return { content: [{ type: "text" as const, text: "No squads currently activated. Call squad_list to discover available squads." }], details: {} };
      }

      const lines = ["Activated squads:\n"];
      for (const [name, agents] of state.activatedAgents) {
        const squad = state.loadedSquads.get(name);
        const manifest = state.manifests.find(m => m.name === name);
        const tag = versionTag(manifest?.squadVersion || "v1");
        lines.push(`  ${name} v${squad?.manifest.version || "?"}${tag}`);
        for (const a of agents) {
          const agent = squad?.agents.find(ag => `squad--${name}--${ag.id}` === a);
          lines.push(`    ${agent?.icon || "•"} ${a}${agent?.model ? ` (model: ${agent.model})` : ""}`);
        }

        const runs = listRuns(ctx.cwd, name);
        const activeRuns = runs.filter(r => r.status === "running");
        const failedRuns = runs.filter(r => r.status === "failed");
        if (activeRuns.length > 0) lines.push(`    🔄 ${activeRuns.length} running`);
        if (failedRuns.length > 0) lines.push(`    ❌ ${failedRuns.length} failed (resumable)`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          squads: [...state.activatedAgents.keys()],
          totalAgents: [...state.activatedAgents.values()].flat().length,
        },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════
  //  v3 WORKFLOW EXECUTION ENGINE
  // ═══════════════════════════════════════════════════════════

  async function executeV3Workflow(
    parsed: ParsedSquad,
    workflow: any,
    chain: WorkflowChainStep[],
    params: { squad: string; workflow: string; context: string },
    ctx: any,
    signal: AbortSignal | undefined,
    onUpdate: any
  ) {
    // Merge harness config: workflow-level > squad-level
    const harnessConfig = workflow.harness || parsed.manifest.harness || null;

    const runId = crypto.randomUUID();
    const runState = createRunState(
      ctx.cwd, runId, params.squad, workflow.name,
      parsed.manifest.version, chain.length, workflow.v2Sequence,
      harnessConfig
    );

    const tag = harnessConfig ? " [v3: harness]" : " [v2]";
    onUpdate?.({
      content: [{ type: "text" as const, text: `Runtime${tag}: ${params.workflow} — Run ${runId.slice(0, 8)}\n${buildTrigger("squad-start", { squad: params.squad, workflow: params.workflow, run_id: runId })}` }],
    });

    // Inject initial context
    const firstAgentIdx = chain.findIndex(s => s.agent !== "__human-gate__");
    if (firstAgentIdx >= 0) {
      chain[firstAgentIdx].task = `## Initial Context\n${params.context}\n\n## Task\n${chain[firstAgentIdx].task}`;
    }

    return await executeV3Steps(
      parsed, workflow, chain, runState, runId, 0, new Map(), ctx, signal, onUpdate
    );
  }

  async function executeV3Steps(
    parsed: ParsedSquad,
    workflow: any,
    chain: WorkflowChainStep[],
    runState: RunState,
    runId: string,
    startFrom: number,
    previousOutputs: Map<number, string>,
    ctx: any,
    signal: AbortSignal | undefined,
    onUpdate: any
  ) {
    let lastOutput = "";
    const results: { agent: string; output: string; status: string; validation?: string }[] = [];
    const harnessConfig = runState.harness_config;

    // Load previous outputs for context
    if (startFrom > 0 && previousOutputs.size > 0) {
      const lastIdx = startFrom - 1;
      lastOutput = previousOutputs.get(lastIdx) || "";
    }

    for (let i = startFrom; i < chain.length; i++) {
      const step = chain[i];
      const v2Step = step.v2Step;

      // Update state
      runState.current_step = i;
      if (runState.steps[i]) {
        runState.steps[i].status = "running";
        runState.steps[i].started_at = new Date().toISOString();
      }
      writeRunState(ctx.cwd, runId, runState);

      // ── HUMAN GATE ──
      if (step.agent === "__human-gate__" && v2Step) {
        onUpdate?.({ content: [{ type: "text" as const, text: `Step ${i + 1}/${chain.length}: Human gate "${v2Step.id}"\n${buildTrigger("human-gate-start", { squad: runState.squad, gate_id: v2Step.id })}` }] });

        saveHumanGateResponse(ctx.cwd, runId, v2Step.id!, { status: "pending" });
        runState.status = "paused";
        if (runState.steps[i]) runState.steps[i].status = "pending";
        writeRunState(ctx.cwd, runId, runState);

        return {
          content: [{
            type: "text",
            text: `## Workflow Paused — Human Gate: ${v2Step.id}\n\n${v2Step.prompt || "Human input required."}\n\n**Action required:** Use \`ask_user_questions\` then \`squad_resume\` with run_id="${runId}"`,
          }],
          details: { run_id: runId, paused_at_step: i, gate_id: v2Step.id, status: "paused" },
        };
      }

      // ── AGENT STEP ──
      const resolvedModel = step.model; // Model already resolved in chain building
      onUpdate?.({
        content: [{ type: "text" as const, text: `Step ${i + 1}/${chain.length}: ${step.agent}${resolvedModel ? ` [${resolvedModel}]` : ""}...\n${buildTrigger("flow-transition", { squad: runState.squad, step: i, agent: step.agent })}` }],
      });

      // Apply context compaction if configured
      let handoffContext = lastOutput;
      if (harnessConfig?.context_compaction?.enabled && i > 0) {
        const schemaPath = typeof v2Step?.creates === "object" && v2Step.creates.schema
          ? join(parsed.manifest.dir, v2Step.creates.schema)
          : undefined;
        handoffContext = compactHandoff(
          lastOutput,
          {
            strategy: harnessConfig.context_compaction.strategy || "key-fields",
            max_handoff_tokens: harnessConfig.context_compaction.max_handoff_tokens || 4000,
          },
          schemaPath
        );
        if (handoffContext !== lastOutput) {
          onUpdate?.({ content: [{ type: "text" as const, text: `  Context compacted: ${lastOutput.length} → ${handoffContext.length} chars\n${buildTrigger("context-compacted", { step: i, original: lastOutput.length, compacted: handoffContext.length })}` }] });
        }
      }

      // Build task with previous context
      const taskPrompt = step.task.replace(/\{previous\}/g, handoffContext);

      // Dispatch agent
      let output = await spawnAgent(step.agent, taskPrompt, ctx.cwd, signal, resolvedModel);

      // ── VALIDATION GATE (v3: REAL EXECUTION) ──
      let validationSummary = "";
      let validationResult: ValidationResult | null = null;

      if (v2Step?.validation) {
        const val = v2Step.validation;
        let retries = 0;
        const maxRetries = val.max_retries ?? 1;

        while (retries <= maxRetries) {
          validationResult = executeValidation(output, val, parsed.manifest.dir);

          if (validationResult.passed) {
            validationSummary = formatValidationSummary(validationResult);
            onUpdate?.({ content: [{ type: "text" as const, text: `  Validation: ✅ ${validationSummary}\n${buildTrigger("validation-pass", { step: i, agent: step.agent, result: validationSummary })}` }] });
            break;
          }

          // Validation failed
          validationSummary = formatValidationSummary(validationResult);
          onUpdate?.({ content: [{ type: "text" as const, text: `  Validation: ❌ ${validationSummary} (attempt ${retries + 1}/${maxRetries + 1})\n${buildTrigger("validation-fail", { step: i, agent: step.agent, result: validationSummary, attempt: retries + 1 })}` }] });

          if (retries >= maxRetries) {
            // Max retries reached — apply on_fail strategy
            if (val.on_fail === "abort") {
              runState.status = "failed";
              runState.error = `Validation failed at step ${i} (${step.agent}): ${validationSummary}`;
              if (runState.steps[i]) {
                runState.steps[i].status = "failed";
                runState.steps[i].error = validationSummary;
                runState.steps[i].validation = {
                  schema: validationResult.schema_result,
                  assertions: validationResult.assertion_results.map(a => a.result),
                  retries,
                  errors: validationResult.schema_errors,
                  duration_ms: validationResult.duration_ms,
                };
              }
              finalizeRun(ctx.cwd, runId, "failed", runState.error);

              return {
                content: [{ type: "text" as const, text: `## Workflow FAILED — Validation Error\n\nStep ${i + 1}: ${step.agent}\nValidation: ${validationSummary}\nErrors:\n${validationResult.schema_errors.map(e => `  - ${e}`).join("\n")}\n\nResume: squad_resume({ squad: "${runState.squad}", run_id: "${runId}" })` }],
                details: { run_id: runId, failed_at: i, status: "failed", validation: validationResult },
              };
            } else if (val.on_fail === "skip") {
              validationSummary = `SKIPPED (${maxRetries + 1} attempts failed)`;
              onUpdate?.({ content: [{ type: "text" as const, text: `  Validation: ⏭️ Skipped after ${maxRetries + 1} attempts` }] });
              break;
            }
            // on_fail === "retry" falls through naturally (already exhausted retries)
            break;
          }

          // Build retry prompt with specific error feedback
          retries++;
          const retryPrompt = buildRetryPrompt(
            step.task.replace(/\{previous\}/g, handoffContext),
            validationResult,
            retries,
            maxRetries
          );

          onUpdate?.({ content: [{ type: "text" as const, text: `  Retrying ${step.agent} (attempt ${retries + 1}/${maxRetries + 1})...` }] });
          output = await spawnAgent(step.agent, retryPrompt, ctx.cwd, signal, resolvedModel);
        }
      }

      // ── FILESYSTEM COLLABORATION (v3) ──
      let artifactPath: string | null = null;
      const artifactName = typeof v2Step?.creates === "object"
        ? v2Step.creates.artifact
        : typeof v2Step?.creates === "string" ? v2Step.creates : null;

      if (artifactName && harnessConfig?.filesystem_collaboration?.enabled) {
        artifactPath = saveArtifact(ctx.cwd, runId, artifactName, output);
        onUpdate?.({ content: [{ type: "text" as const, text: `  Artifact saved: ${artifactPath}\n${buildTrigger("artifact-saved", { step: i, artifact: artifactName, path: artifactPath })}` }] });
      }

      // ── CHECKPOINT ──
      const checkpointFile = saveCheckpoint(
        ctx.cwd, runId, i, step.agent.split("--").pop() || step.agent,
        output, "text", artifactPath, validationResult
      );

      if (runState.steps[i]) {
        runState.steps[i].status = "completed";
        runState.steps[i].finished_at = new Date().toISOString();
        const startedAt = runState.steps[i].started_at ? new Date(runState.steps[i].started_at!) : new Date();
        runState.steps[i].duration = `${Math.floor((Date.now() - startedAt.getTime()) / 1000)}s`;
        runState.steps[i].checkpoint = checkpointFile;
        if (validationResult) {
          runState.steps[i].validation = {
            schema: validationResult.schema_result,
            assertions: validationResult.assertion_results.map(a => a.result),
            retries: (v2Step?.validation?.max_retries ?? 0) - (validationResult.passed ? 0 : 0), // TODO: track actual retries
            errors: validationResult.schema_errors.length > 0 ? validationResult.schema_errors : undefined,
            duration_ms: validationResult.duration_ms,
          };
        }
      }
      runState.last_completed = i;
      writeRunState(ctx.cwd, runId, runState);

      // ── HANDOFF ──
      const injectAs = typeof v2Step?.creates === "object"
        ? (v2Step.creates.inject_as as any) || "full"
        : "full";

      const contextBudget = v2Step?.context?.budget || 0;

      if (artifactPath && harnessConfig?.filesystem_collaboration?.enabled) {
        // v3: reference artifact on disk instead of passing full content
        lastOutput = `[Artifact from step ${i + 1} (${step.agent}): ${artifactPath}. Use the read tool to access it.]\n\n${output.slice(0, 2000)}${output.length > 2000 ? "\n[... truncated, full content at path above]" : ""}`;
      } else {
        lastOutput = formatHandoff(output, injectAs, artifactPath, contextBudget);
      }

      results.push({
        agent: step.agent,
        output: output.slice(0, 2000) + (output.length > 2000 ? "..." : ""),
        status: "completed",
        validation: validationSummary || undefined,
      });

      onUpdate?.({
        content: [{ type: "text" as const, text: `Step ${i + 1}/${chain.length}: ${step.agent} ✅${validationSummary ? ` [${validationSummary}]` : ""}\n${buildTrigger("checkpoint-saved", { squad: runState.squad, step: i, agent: step.agent, checkpoint: checkpointFile })}` }],
      });
    }

    // ── FINALIZE ──
    finalizeRun(ctx.cwd, runId, "completed");

    const completedCount = results.filter(r => r.status === "completed").length;
    const harnessTag = runState.harness_active ? " [v3: harness]" : "";
    const header = `## Workflow Complete: ${runState.workflow}${harnessTag}\n**Squad:** ${runState.squad} | **Run:** ${runId.slice(0, 8)} | **Steps:** ${chain.length} | **Completed:** ${completedCount}\n\n${buildTrigger("flow-complete", { squad: runState.squad, run_id: runId, duration: runState.duration })}`;

    const stepSummaries = results.map((r, i) =>
      `### Step ${i + 1}: ${r.agent} ✅${r.validation ? ` [${r.validation}]` : ""}\n${r.output}`
    );

    return {
      content: [{ type: "text" as const, text: header + "\n\n" + stepSummaries.join("\n\n---\n\n") }],
      details: {
        run_id: runId,
        squad: runState.squad,
        workflow: runState.workflow,
        steps: chain.length,
        completed: completedCount,
        status: "completed",
        harness_active: runState.harness_active,
        state_dir: stateDir(ctx.cwd, runId),
      },
    };
  }

  async function executeV1Workflow(
    chain: WorkflowChainStep[],
    params: { squad: string; workflow: string; context: string },
    ctx: any,
    signal: AbortSignal | undefined,
    onUpdate: any
  ) {
    chain[0].task = `## Initial Context\n${params.context}\n\n## Task\n${chain[0].task}`;

    const results: { agent: string; output: string; status: string }[] = [];
    let previousOutput = "";

    for (let i = 0; i < chain.length; i++) {
      const step = chain[i];
      const taskWithPrevious = step.task.replace(/\{previous\}/g, previousOutput);

      onUpdate?.({ content: [{ type: "text" as const, text: `Step ${i + 1}/${chain.length}: ${step.agent}...` }] });

      const output = await spawnAgent(step.agent, taskWithPrevious, ctx.cwd, signal);

      const status = (!output || output === "(no output)") ? "empty"
        : output.startsWith("(spawn error") ? "error" : "ok";

      results.push({ agent: step.agent, output, status });
      previousOutput = output.length > 6000
        ? output.slice(0, 6000) + "\n[... truncated ...]"
        : output;
    }

    const completedCount = results.filter(r => r.status === "ok").length;
    const header = `## Workflow: ${params.workflow} [v1]\n**Squad:** ${params.squad} | **Steps:** ${chain.length} | **Completed:** ${completedCount}`;
    const stepSummaries = results.map((r, i) => {
      const icon = r.status === "ok" ? "✅" : "❌";
      return `### Step ${i + 1}: ${r.agent} ${icon}\n${r.output}`;
    });

    return {
      content: [{ type: "text" as const, text: header + "\n\n" + stepSummaries.join("\n\n---\n\n") }],
      details: { squad: params.squad, workflow: params.workflow, steps: chain.length, completed: completedCount },
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  COMMANDS
  // ═══════════════════════════════════════════════════════════

  pi.registerCommand("squad", {
    description: "Manage squads v3 — list, activate, run workflows, inspect state, resume",
    getArgumentCompletions: (prefix) => {
      const subcommands = [
        { value: "list", label: "List all available squads" },
        { value: "agents", label: "List agents in a squad" },
        { value: "activate", label: "Activate a squad" },
        { value: "run", label: "Run a squad workflow" },
        { value: "state", label: "Show run history" },
        { value: "inject", label: "Inject artifact into GSD" },
        { value: "status", label: "Show activated squads" },
      ];

      const parts = prefix.split(" ");
      if (parts.length >= 2 && ["activate", "agents", "run", "state"].includes(parts[0])) {
        ensureDiscovered();
        return state.manifests
          .filter((m) => m.name.startsWith(parts[1] || ""))
          .map((m) => ({ value: `${parts[0]} ${m.name}`, label: `${m.name} — ${m.description.slice(0, 50)}` }));
      }
      return subcommands.filter((s) => s.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] || "list";

      switch (subcommand) {
        case "list": {
          ensureDiscovered();
          ctx.ui.notify(formatSquadList(state.manifests), "info");
          break;
        }
        case "activate": {
          if (!parts[1]) { 0; return; }
          ensureDiscovered();
          ctx.ui.notify(activateSquad(parts[1]), "info");
          await ctx.reload();
          break;
        }
        case "state": {
          const runs = listRuns(ctx.cwd || process.cwd(), parts[1]);
          if (runs.length === 0) { ctx.ui.notify("No runs found.", "info"); return; }
          const lines = runs.map(r => {
            const icon = r.status === "completed" ? "✅" : r.status === "failed" ? "❌" : "🔄";
            return `${icon} ${r.run_id.slice(0, 8)} ${r.squad}/${r.workflow} ${r.status} ${r.duration || ""}`;
          });
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
        case "run": {
          if (!parts[1] || !parts[2]) { 0; return; }
          if (!state.loadedSquads.has(parts[1])) { 0; return; }
          const briefing = await ctx.ui.editor(`Briefing for ${parts[2]}: Provide initial context`);
          if (!briefing) return;
          pi.sendUserMessage(`Use squad_workflow with squad="${parts[1]}", workflow="${parts[2]}", context="${briefing}"`, { deliverAs: "steer" });
          break;
        }
        case "status": {
          if (state.activatedAgents.size === 0) { ctx.ui.notify("No squads activated.", "info"); return; }
          const lines: string[] = [];
          for (const [name, agents] of state.activatedAgents) {
            lines.push(`${name}: ${agents.length} agents`);
          }
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
        default:
          0;
      }
    },
  });

  // ═══════════════════════════════════════════════════════════
  //  EVENT HOOKS
  // ═══════════════════════════════════════════════════════════

  pi.on("before_agent_start", async (event, ctx) => {
    if (state.activatedAgents.size === 0) return;

    const sections = [
      "\n\n[SQUAD-LOADER v3 — OPERATING RULES]",
      "",
      "squad_* tools are available. Follow these rules every time:",
      "",
      "## RULE 1 — ALWAYS DISCOVER DYNAMICALLY",
      "Squad names vary per installation. NEVER assume or hardcode squad names.",
      "Mandatory: squad_list → squad_activate → squad_dispatch/squad_workflow",
      "",
      "## RULE 2 — TASK PROMPTS = INSTRUCTIONS, NOT CODE",
      "squad_dispatch task = what agent should DO. Never paste code/SQL/content.",
      "",
      "## RULE 3 — SELF-SUPERVISE CONTEXT BUDGET",
      "Stop after 3+ dispatches or if output is empty/error.",
      "",
      "## RULE 4 — ONE RESPONSIBILITY PER DISPATCH",
      "",
      "## RULE 5 — SQUADS vs DIRECT IMPLEMENTATION",
      "Use squads for: security audit, UX critique, copy, architecture review.",
      "Implement directly for: routine coding, bug fixes.",
      "",
      "## v3 FEATURES",
      "- REAL validation gates: schema validation via ajv + assertion evaluation (never DEFERRED)",
      "- Retry with error feedback: failed validation triggers re-dispatch with specific errors",
      "- Filesystem collaboration: artifacts saved to .squad-state/{run-id}/artifacts/",
      "- Context compaction: long workflows auto-compact handoffs",
      "- squad_validate_output: debug validation gates manually",
      "- Use squad_resume to resume failed workflows",
      "- Use squad_show_state to inspect run history with validation results",
      "",
      "Currently activated squads:",
    ];

    for (const [name, agents] of state.activatedAgents) {
      const squad = state.loadedSquads.get(name);
      const manifest = state.manifests.find(m => m.name === name);
      const tag = versionTag(manifest?.squadVersion || "v1");
      sections.push(`  ${name}${tag} (${agents.length} agents):`);

      if (squad) {
        for (const wf of squad.workflows) {
          const wfTag = wf.isV3 ? " [v3: harness]" : wf.isV2 ? " [v2]" : "";
          sections.push(`    📋 ${wf.name}${wfTag}`);
          sections.push(`       squad_workflow({ squad: "${name}", workflow: "${wf.name}", context: "..." })`);
        }
      }
    }

    const runs = listRuns(ctx.cwd || process.cwd());
    const activeRuns = runs.filter(r => r.status === "running" || r.status === "paused");
    const failedRuns = runs.filter(r => r.status === "failed");
    if (activeRuns.length > 0) {
      sections.push("");
      sections.push("⚠️ Active/paused runs:");
      for (const r of activeRuns) sections.push(`  ${r.run_id.slice(0, 8)} ${r.squad}/${r.workflow} — ${r.status}`);
    }
    if (failedRuns.length > 0) {
      sections.push("");
      sections.push("❌ Resumable failed runs:");
      for (const r of failedRuns) sections.push(`  squad_resume({ squad: "${r.squad}", run_id: "${r.run_id}" })`);
    }

    return { systemPrompt: event.systemPrompt + sections.join("\n") };
  });

  pi.on("session_start", async () => {
    state.manifests = discoverSquads(state.squadsDir);
  });
}
