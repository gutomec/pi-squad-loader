/**
 * squad-loader — GSD-PI Extension
 *
 * Loads the Squads ecosystem into GSD-PI as native subagents.
 * Squad agents become Pi subagents, squad workflows become chain dispatches.
 *
 * Key improvements over v1:
 * - squad_dispatch resolves task contracts and injects them into the prompt
 * - squad_workflow validates pre/post conditions per step
 * - squad_workflow implements retry logic from task Error Handling config
 * - Trigger events are emitted to .aios/squad-triggers/ when enabled
 * - Agent prompts are delivered via stdin (not CLI args) to avoid ARG_MAX
 * - Output validation parses the agent's self-validation report
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { join, resolve } from "path";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import {
  discoverSquads,
  parseFullSquad,
  type SquadManifest,
  type ParsedSquad,
} from "../lib/squad-parser.js";
import {
  adaptSquad,
  buildWorkflowPlan,
  buildTaskPrompt,
  buildDispatchPrompt,
  resolveAgentTasks,
  validateStepOutput,
  type WorkflowStep,
} from "../lib/agent-adapter.js";

// ─── State ───────────────────────────────────────────────────

interface SquadLoaderState {
  squadsDir: string;
  manifests: SquadManifest[];
  loadedSquads: Map<string, ParsedSquad>;
  activatedAgents: Map<string, string[]>;
  agentsCacheDir: string;
}

const state: SquadLoaderState = {
  squadsDir: "",
  manifests: [],
  loadedSquads: new Map(),
  activatedAgents: new Map(),
  agentsCacheDir: "",
};

// ─── Helpers ─────────────────────────────────────────────────

function ensureDiscovered(): boolean {
  if (state.manifests.length === 0) {
    state.manifests = discoverSquads(state.squadsDir);
  }
  return state.manifests.length > 0;
}

function formatSquadList(manifests: SquadManifest[]): string {
  if (manifests.length === 0) return "No squads found.";

  const lines = [`Found ${manifests.length} squads in ${state.squadsDir}:\n`];
  for (const m of manifests) {
    const agentCount = m.components.agents.length;
    const taskCount = m.components.tasks.length;
    const wfCount = m.components.workflows.length;
    const activated = state.activatedAgents.has(m.name) ? " [ACTIVE]" : "";
    lines.push(
      `  ${m.name} v${m.version}${activated} — ${agentCount} agents, ${taskCount} tasks, ${wfCount} workflows`
    );
    if (m.description) {
      lines.push(`    ${m.description.slice(0, 100)}${m.description.length > 100 ? "..." : ""}`);
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

  const lines = [
    `Squad "${name}" activated with ${adapted.length} agents:\n`,
    ...adapted.map((a) => `  ${a.source.icon} ${a.piName} — ${a.source.title}`),
    "",
    `Agents written to: ${state.agentsCacheDir}`,
    "",
    "These agents are now available as subagents.",
    'Use the subagent tool to dispatch them, e.g.:',
    `  { "agent": "${agentNames[0]}", "task": "..." }`,
  ];

  if (parsed.tasks.length > 0) {
    lines.push("");
    lines.push(`Task contracts loaded: ${parsed.tasks.length} (${parsed.tasks.map(t => t.name).join(", ")})`);
  }

  if (parsed.workflows.length > 0) {
    lines.push("");
    lines.push("Available workflows:");
    for (const wf of parsed.workflows) {
      lines.push(`  ${wf.name} — ${wf.description.slice(0, 80)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Reverse lookup: find which squad an agent belongs to.
 */
function findSquadForAgent(agentPiName: string): ParsedSquad | null {
  for (const [name, agents] of state.activatedAgents) {
    if (agents.includes(agentPiName)) {
      return state.loadedSquads.get(name) || null;
    }
  }
  return null;
}

// ─── Trigger Emission ────────────────────────────────────────

function emitTrigger(
  squad: ParsedSquad,
  cwd: string,
  event: Record<string, any>
): void {
  if (!squad.manifest.triggers.enabled) return;

  try {
    const logDir = join(cwd, squad.manifest.triggers.logPath);
    mkdirSync(logDir, { recursive: true });

    const logPath = join(logDir, `${squad.manifest.name}.jsonl`);
    const line = JSON.stringify({
      ...event,
      squad: squad.manifest.name,
      prefix: squad.manifest.slashPrefix,
      timestamp: new Date().toISOString(),
    });
    appendFileSync(logPath, line + "\n");
  } catch {
    // Non-critical — never block execution for trigger failures
  }
}

// ─── Retry Delay ─────────────────────────────────────────────

function parseDelay(delay: string): number {
  if (!delay || delay === "immediate" || delay === "0s") return 0;
  const match = delay.match(/^(\d+)(ms|s|m)?$/);
  if (!match) return 1000;
  const val = Number(match[1]);
  switch (match[2]) {
    case "ms": return val;
    case "m": return val * 60_000;
    case "s": default: return val * 1000;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Agent Spawn ─────────────────────────────────────────────

/**
 * Spawns a squad agent as a gsd subprocess in json/print mode.
 *
 * Key design decisions:
 * - Prompt is delivered via stdin (not CLI arg) to avoid ARG_MAX limits
 * - System prompt is appended via --append-system-prompt temp file
 * - Model is inherited from session (not hardcoded per agent)
 */
async function spawnSquadAgent(
  agentName: string,
  taskPrompt: string,
  cwd: string,
  signal?: AbortSignal,
  onStepUpdate?: (text: string) => void
): Promise<string> {
  const agentPath = join(state.agentsCacheDir, `${agentName}.md`);
  if (!existsSync(agentPath))
    return `[squad-agent] Agent ${agentName} not found in cache.`;

  // Parse agent file for optional model, tools, and system prompt
  let agentModel: string | undefined;
  let agentTools: string[] = [];
  let agentSystemPrompt = "";
  try {
    const agentContent = readFileSync(agentPath, "utf8");
    const fmMatch = agentContent.match(
      /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
    );
    if (fmMatch) {
      const fmBlock = fmMatch[1];
      agentSystemPrompt = fmMatch[2];
      try {
        const parsed = (await import("js-yaml")).default.load(fmBlock) as Record<string, any>;
        if (parsed) {
          if (parsed.model) agentModel = String(parsed.model);
          if (parsed.tools) {
            agentTools = String(parsed.tools)
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean);
          }
        }
      } catch {
        for (const line of fmBlock.split("\n")) {
          const modelMatch = line.match(/^model:\s*(.+)$/);
          if (modelMatch) agentModel = modelMatch[1].trim();
          const toolsMatch = line.match(/^tools:\s*(.+)$/);
          if (toolsMatch)
            agentTools = toolsMatch[1]
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean);
        }
      }
    }
  } catch {
    /* ignore parse errors */
  }

  return new Promise<string>((resolvePromise) => {
    const args: string[] = ["--mode", "json", "-p", "--no-session"];
    if (agentModel) args.push("--model", agentModel);
    if (agentTools.length > 0) args.push("--tools", agentTools.join(","));

    // Write system prompt to temp file for --append-system-prompt
    let tmpDir: string | null = null;
    let tmpPath: string | null = null;
    if (agentSystemPrompt.trim()) {
      tmpDir = fs.mkdtempSync(join(os.tmpdir(), "squad-agent-"));
      tmpPath = join(tmpDir, `${agentName}.md`);
      fs.writeFileSync(tmpPath, agentSystemPrompt, {
        encoding: "utf-8",
        mode: 0o600,
      });
      args.push("--append-system-prompt", tmpPath);
    }

    // NOTE: Prompt is NOT passed as a CLI arg anymore.
    // It's delivered via stdin to avoid ARG_MAX limits with large prompts.

    const bundledPaths = (process.env.GSD_BUNDLED_EXTENSION_PATHS ?? "")
      .split(":")
      .filter(Boolean);
    const extensionArgs = bundledPaths.flatMap((p) => ["--extension", p]);

    const proc = spawn(
      process.execPath,
      [process.env.GSD_BIN_PATH!, ...extensionArgs, ...args],
      { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] }
    );

    // Deliver prompt via stdin then close (triggers readPipedStdin in Pi)
    proc.stdin!.end(taskPrompt);

    let buffer = "";
    let finalOutput = "";
    let stderr = "";
    let turns = 0;

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (
        event.type === "message_end" &&
        event.message?.role === "assistant"
      ) {
        turns++;
        for (const part of event.message.content ?? []) {
          if (part.type === "text") {
            finalOutput = part.text;
            onStepUpdate?.(finalOutput);
          }
        }
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);

      // Cleanup temp files
      try { if (tmpPath) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      try { if (tmpDir) fs.rmdirSync(tmpDir); } catch { /* ignore */ }

      if (!finalOutput) {
        if (code !== 0) {
          resolvePromise(
            `[squad-agent] Agent ${agentName} exited with code ${code}.\n${
              stderr ? stderr.trim() : "(no stderr)"
            }`
          );
        } else if (turns === 0) {
          resolvePromise(
            `[squad-agent] Agent ${agentName} produced no output (0 turns).\n${
              stderr ? stderr.trim() : ""
            }`
          );
        } else {
          resolvePromise("(no text output)");
        }
      } else {
        resolvePromise(finalOutput);
      }
    });

    proc.on("error", (err) =>
      resolvePromise(`[squad-agent] Spawn error for ${agentName}: ${err.message}`)
    );

    if (signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
  });
}

// ─── Extension Entry Point ───────────────────────────────────

export default function squadLoader(pi: ExtensionAPI) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  state.squadsDir = resolve(homeDir, "squads");
  state.agentsCacheDir = resolve(homeDir, ".gsd", "agent", "agents");

  if (!existsSync(state.agentsCacheDir)) {
    mkdirSync(state.agentsCacheDir, { recursive: true });
  }

  // ─── Tools ───────────────────────────────────────────────

  pi.registerTool({
    name: "squad_list",
    label: "Squad List",
    description: "List all available squads from ~/squads/",
    promptSnippet: "List available squads and their agents",
    promptGuidelines: [
      "Use this tool to discover what squads are available before activating them",
      "Shows squad name, version, agent count, and activation status",
    ],
    parameters: Type.Object({
      filter: Type.Optional(
        Type.String({ description: "Filter squads by name or tag" })
      ),
    }),
    async execute(toolCallId, params) {
      ensureDiscovered();
      let filtered = state.manifests;
      if (params.filter) {
        const f = params.filter.toLowerCase();
        filtered = state.manifests.filter(
          (m) =>
            m.name.toLowerCase().includes(f) ||
            m.tags.some((t) => t.toLowerCase().includes(f)) ||
            m.description.toLowerCase().includes(f)
        );
      }
      const text = formatSquadList(filtered);
      return {
        content: [{ type: "text", text }],
        details: {
          count: filtered.length,
          squads: filtered.map((m) => m.name),
        },
      };
    },
  });

  pi.registerTool({
    name: "squad_activate",
    label: "Squad Activate",
    description:
      "Activate a squad, loading its agents as Pi subagents available for dispatch",
    promptSnippet: "Activate a squad to make its agents available as subagents",
    promptGuidelines: [
      "Activate a squad before dispatching its agents",
      "Agents are written as Pi-compatible .md files to the agents cache",
      "Once activated, agents can be dispatched via the subagent tool",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Squad name to activate" }),
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      ensureDiscovered();
      onUpdate?.({
        content: [{ type: "text", text: `Activating squad "${params.name}"...` }],
      });
      const result = activateSquad(params.name);
      return {
        content: [{ type: "text", text: result }],
        details: {
          squad: params.name,
          agents: state.activatedAgents.get(params.name) || [],
          activated: state.activatedAgents.has(params.name),
        },
      };
    },
  });

  // ─── squad_dispatch — Task-Aware Agent Dispatch ──────────

  pi.registerTool({
    name: "squad_dispatch",
    label: "Squad Dispatch",
    description:
      "Dispatch a specific squad agent to perform a task. The agent runs as an isolated subagent with its full persona, principles, and task knowledge.",
    promptSnippet: "Dispatch a squad agent to perform specialized work",
    promptGuidelines: [
      "The squad must be activated first via squad_activate",
      "Provide the full agent ID: squad--{squad-name}--{agent-id}",
      "TASK PROMPT = INSTRUCTIONS, NOT CODE. Write what the agent should DO, not the implementation itself.",
      "The agent has its own tools (read, write, edit, bash, search) — it reads files and implements by itself.",
      "Reference file paths instead of pasting file contents: e.g. 'Read src/lib/billing.ts and add Stripe Connect functions as described in .gsd/milestones/M001/slices/S09/S09-PLAN.md T02'",
      "Reference plan docs instead of duplicating specs: e.g. 'Implement T01 from S09-PLAN.md — DB migration for multi-tenant'",
      "Keep task prompts SHORT and DIRECTIVE: WHO does WHAT, WHERE to find context, WHAT success looks like",
      "NEVER paste SQL migrations, TypeScript code, or full file contents inline in the task prompt",
      "NEVER duplicate content that already exists in plan files (.gsd/milestones/) or docs",
      "NEVER send multiple large tasks in a single dispatch — break into focused single-responsibility tasks",
      "NEVER use squads for tasks you can implement directly — use them for domain expertise (design, copy, security audit, architecture review)",
      "GOOD: 'Read S09-PLAN.md T01, implement the DB migration in supabase/migrations/, run verify-s09.sh to confirm'",
      "GOOD: 'Review src/lib/admin.ts for security vulnerabilities. Focus on auth bypass and injection risks. Report severity + fix per issue.'",
      "BAD: 'Implement this migration: [500 lines of SQL pasted here]...'",
      "BAD: 'Create this file: [full TypeScript implementation pasted here]...'",
    ],
    parameters: Type.Object({
      agent: Type.String({
        description: 'Full Pi agent name (e.g. "squad--brandcraft--bc-extractor")',
      }),
      task: Type.String({
        description: "Task description with full context for the agent",
      }),
      context: Type.Optional(
        Type.String({
          description: "Additional context to inject (e.g. previous agent output)",
        })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Verify agent file exists
      const agentPath = join(state.agentsCacheDir, `${params.agent}.md`);
      if (!existsSync(agentPath)) {
        return {
          content: [
            {
              type: "text",
              text: `Agent "${params.agent}" not found. Activate the squad first with squad_activate.`,
            },
          ],
          isError: true,
        };
      }

      // Task prompt size guard
      const TASK_WARN_BYTES = 4_096;
      const TASK_HARD_BYTES = 16_384;
      const taskBytes = Buffer.byteLength(params.task, "utf8");
      if (taskBytes > TASK_HARD_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: [
                `[SQUAD-LOADER] Task prompt is too large (${Math.round(taskBytes / 1024)}KB). Dispatch rejected.`,
                "",
                "Rule: task prompts must be INSTRUCTIONS, not code or file contents.",
                "Reference file paths instead of pasting content.",
                "Reduce the task prompt to under 4KB and retry.",
              ].join("\n"),
            },
          ],
          isError: true,
        };
      }
      if (taskBytes > TASK_WARN_BYTES) {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `[SQUAD-LOADER] Warning: task prompt is ${Math.round(taskBytes / 1024)}KB. Prefer referencing file paths over pasting content inline.`,
            },
          ],
        });
      }

      // ── Resolve task contract for this agent ──────────────
      const squad = findSquadForAgent(params.agent);
      const agentTasks = squad ? resolveAgentTasks(squad, params.agent) : [];

      // Build enriched prompt with task contract
      const taskPrompt = buildDispatchPrompt(params.task, agentTasks, params.context);

      // Emit triggers
      if (squad) {
        emitTrigger(squad, ctx.cwd, {
          type: "agent-start",
          agent: params.agent,
          taskContracts: agentTasks.map((t) => t.name),
        });
      }

      const startTime = Date.now();

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Dispatching ${params.agent}...` +
              (agentTasks.length > 0
                ? ` (task contract: ${agentTasks.map((t) => t.name).join(", ")})`
                : " (no task contract found — running with user prompt only)"),
          },
        ],
        details: { agent: params.agent, task: params.task },
      });

      const output = await spawnSquadAgent(
        params.agent,
        taskPrompt,
        ctx.cwd,
        signal,
        (text) =>
          onUpdate?.({
            content: [{ type: "text", text }],
            details: { agent: params.agent, task: params.task },
          })
      );

      const duration = Date.now() - startTime;

      // ── Validate output against task contract ─────────────
      const taskContract = agentTasks.length > 0
        ? {
            name: agentTasks[0].name,
            inputs: agentTasks[0].entrada,
            outputs: agentTasks[0].saida,
            preConditions: agentTasks[0].preConditions,
            postConditions: agentTasks[0].postConditions,
            acceptanceCriteria: agentTasks[0].acceptanceCriteria,
            content: agentTasks[0].content,
          }
        : null;

      const validation = validateStepOutput(output, taskContract);

      // Emit end trigger
      if (squad) {
        emitTrigger(squad, ctx.cwd, {
          type: "agent-end",
          agent: params.agent,
          duration: `${Math.round(duration / 1000)}s`,
          validation: validation.summary,
          isError: validation.isError,
        });
      }

      // Build result with validation report
      const resultText = validation.isError
        ? output
        : [
            output,
            "",
            "---",
            `**Task Contract Validation:** ${validation.summary}`,
            ...(validation.passed.length > 0
              ? [`**Passed:** ${validation.passed.join("; ")}`]
              : []),
            ...(validation.failed.length > 0
              ? [`**Failed:** ${validation.failed.join("; ")}`]
              : []),
          ].join("\n");

      return {
        content: [{ type: "text", text: resultText }],
        details: {
          agent: params.agent,
          task: params.task,
          taskContracts: agentTasks.map((t) => t.name),
          validation,
          durationMs: duration,
        },
      };
    },
  });

  // ─── squad_workflow — Full Contract Execution Engine ──────

  pi.registerTool({
    name: "squad_workflow",
    label: "Squad Workflow",
    description:
      "Run a complete squad workflow as a chain of subagent dispatches. Each agent receives the output of the previous one.",
    promptSnippet: "Run a multi-agent squad workflow as a sequential chain",
    promptGuidelines: [
      "The squad must be activated first",
      "Provide the workflow name from the squad's workflows/",
      "Each step runs as a separate subagent with {previous} replaced by prior output",
      "Provide initial context that the first agent needs",
      "Context should be a BRIEFING (project goal, constraints, where to find specs) — not code or file contents",
      "Good context: 'Project: Metabolic Monitor SaaS. Stack: Next.js 15, Supabase, Stripe. Codebase: /Users/guto/Projects/metabolic-monitor-v2. Specs: .gsd/milestones/M001/slices/S09/S09-PLAN.md'",
      "Bad context: '[500 lines of SQL and TypeScript pasted here]'",
    ],
    parameters: Type.Object({
      squad: Type.String({ description: "Squad name" }),
      workflow: Type.String({ description: "Workflow name" }),
      context: Type.String({
        description:
          "Initial context/briefing for the workflow (passed to the first agent)",
      }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const parsed = state.loadedSquads.get(params.squad);
      if (!parsed) {
        return {
          content: [
            {
              type: "text",
              text: `Squad "${params.squad}" not activated. Use squad_activate first.`,
            },
          ],
          isError: true,
        };
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Building task-aware workflow plan for "${params.workflow}"...`,
          },
        ],
      });

      const plan = buildWorkflowPlan(parsed, params.workflow);
      if (!plan || plan.steps.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Workflow "${params.workflow}" not found in squad "${params.squad}".`,
            },
          ],
          isError: true,
        };
      }

      // Emit squad-start trigger
      emitTrigger(parsed, ctx.cwd, {
        type: "squad-start",
        workflow: plan.name,
        totalSteps: plan.steps.length,
        agents: plan.steps.map((s) => s.agentId),
      });

      const workflowStartTime = Date.now();

      // ── Dependency-based execution engine with retry ──────

      const completedArtifacts = new Map<string, string>();
      const failedArtifacts = new Set<string>();
      const remaining = [...plan.steps];
      const results: {
        step: number;
        agent: string;
        agentId: string;
        output: string;
        creates: string;
        wave: number;
        parallelWith: string[];
        validation: ReturnType<typeof validateStepOutput> | null;
        attempts: number;
        durationMs: number;
      }[] = [];
      let stepCounter = 0;
      let waveCounter = 0;

      while (remaining.length > 0) {
        // Skip steps blocked by failed dependencies
        const blocked = remaining.filter((step) =>
          step.requires.some((req) => failedArtifacts.has(req))
        );
        for (const b of blocked) {
          remaining.splice(remaining.indexOf(b), 1);
          stepCounter++;
          const failedDep = b.requires.find((r) => failedArtifacts.has(r));
          results.push({
            step: stepCounter,
            agent: b.agent,
            agentId: b.agentId,
            output: `⏭️ Skipped: dependency "${failedDep}" failed in a previous step.`,
            creates: b.creates,
            wave: waveCounter,
            parallelWith: [],
            validation: null,
            attempts: 0,
            durationMs: 0,
          });
          if (b.creates) failedArtifacts.add(b.creates);

          emitTrigger(parsed, ctx.cwd, {
            type: "agent-end",
            agent: b.agentId,
            status: "skipped",
            reason: `dependency "${failedDep}" failed`,
          });
        }

        // Find ready steps (all requires completed)
        const ready = remaining.filter((step) =>
          step.requires.every((req) => !req || completedArtifacts.has(req))
        );

        if (ready.length === 0) {
          if (remaining.length > 0) {
            for (const r of remaining) {
              stepCounter++;
              results.push({
                step: stepCounter,
                agent: r.agent,
                agentId: r.agentId,
                output: `❌ Deadlock: requires [${r.requires.join(", ")}] which were never created.`,
                creates: r.creates,
                wave: waveCounter,
                parallelWith: [],
                validation: null,
                attempts: 0,
                durationMs: 0,
              });
            }
          }
          break;
        }

        waveCounter++;
        for (const r of ready) {
          remaining.splice(remaining.indexOf(r), 1);
        }

        // Report wave start
        const agentShortNames = ready.map((s) => s.agentId);
        const parallelLabel =
          ready.length > 1 ? ` 🔀 parallel: ${agentShortNames.join(", ")}` : "";
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `\n── Wave ${waveCounter}/${Math.ceil(plan.steps.length / ready.length)}: ${ready.length} step(s)${parallelLabel} ──`,
            },
          ],
        });

        // Execute each step in the wave (with retry)
        const execPromises = ready.map(async (step) => {
          return executeStepWithRetry(step, completedArtifacts, params.context, parsed, ctx.cwd, signal, onUpdate);
        });

        const waveResults = await Promise.all(execPromises);

        // Register results
        const parallelAgentNames = ready.length > 1 ? ready.map((s) => s.agent) : [];
        for (const wr of waveResults) {
          stepCounter++;
          results.push({
            step: stepCounter,
            agent: wr.step.agent,
            agentId: wr.step.agentId,
            output: wr.output,
            creates: wr.step.creates,
            wave: waveCounter,
            parallelWith: parallelAgentNames.filter((a) => a !== wr.step.agent),
            validation: wr.validation,
            attempts: wr.attempts,
            durationMs: wr.durationMs,
          });

          if (wr.step.creates) {
            if (wr.validation?.isError || wr.validation?.blockersFailed) {
              failedArtifacts.add(wr.step.creates);
            } else {
              completedArtifacts.set(wr.step.creates, wr.output);
            }
          }

          // Emit flow-transition
          emitTrigger(parsed, ctx.cwd, {
            type: "flow-transition",
            from: wr.step.agentId,
            to: remaining[0]?.agentId || "end",
            artifact: wr.step.creates,
            validation: wr.validation?.summary,
            progress: `${stepCounter}/${plan.steps.length}`,
          });
        }
      }

      // Emit flow-complete
      const totalDuration = Date.now() - workflowStartTime;
      emitTrigger(parsed, ctx.cwd, {
        type: "flow-complete",
        workflow: plan.name,
        totalDuration: `${Math.round(totalDuration / 1000)}s`,
        agentsExecuted: results.filter((r) => r.attempts > 0).length,
        artifactsCreated: [...completedArtifacts.keys()],
        artifactsFailed: [...failedArtifacts],
      });

      // ── Format final summary ───────────────────────────────
      const completedCount = results.filter(
        (r) =>
          r.validation && !r.validation.isError && !r.validation.blockersFailed
      ).length;
      const skippedCount = results.filter((r) => r.output.startsWith("⏭️")).length;
      const failedCount = results.filter(
        (r) =>
          r.validation?.isError ||
          r.validation?.blockersFailed ||
          r.output.startsWith("❌")
      ).length;

      const summaryHeader = [
        `## Workflow: ${plan.name}`,
        `**Squad:** ${params.squad} | **Steps:** ${plan.steps.length} | **Completed:** ${completedCount} | **Skipped:** ${skippedCount} | **Failed:** ${failedCount} | **Duration:** ${Math.round(totalDuration / 1000)}s`,
        "",
      ].join("\n");

      const stepSummaries = results
        .map((r) => {
          const parallelNote =
            r.parallelWith.length > 0
              ? ` _(parallel with ${r.parallelWith.map((a) => a.split("--").pop()).join(", ")})_`
              : "";

          const taskInfo = plan.steps.find((s) => s.agent === r.agent);
          const contractNote = taskInfo?.taskContract
            ? `\n**Task:** ${taskInfo.taskContract.name} | **Outputs:** ${taskInfo.taskContract.outputs.map((o) => o.nome).join(", ") || "—"}`
            : "";

          const validationNote = r.validation
            ? `\n**Validation:** ${r.validation.summary}`
            : "";

          const retryNote =
            r.attempts > 1 ? `\n**Attempts:** ${r.attempts}` : "";

          const durationNote =
            r.durationMs > 0
              ? `\n**Duration:** ${Math.round(r.durationMs / 1000)}s`
              : "";

          return `### Step ${r.step}: ${r.agent}${parallelNote}${contractNote}${validationNote}${retryNote}${durationNote}\n${r.output}`;
        })
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: summaryHeader + stepSummaries }],
        details: {
          squad: params.squad,
          workflow: params.workflow,
          steps: plan.steps.length,
          completed: completedCount,
          skipped: skippedCount,
          failed: failedCount,
          durationMs: totalDuration,
          agents: plan.steps.map((s) => s.agent),
          artifacts: [...completedArtifacts.keys()],
          failedArtifacts: [...failedArtifacts],
          validations: results
            .filter((r) => r.validation)
            .map((r) => ({
              agent: r.agentId,
              ...r.validation,
            })),
        },
      };
    },
  });

  /**
   * Execute a single workflow step with retry logic.
   *
   * Retry is controlled by the task's Error Handling config:
   * - strategy: "retry" → retry up to maxAttempts
   * - strategy: "fallback" → on failure, try fallback action
   * - strategy: "abort" → fail immediately (default)
   */
  async function executeStepWithRetry(
    step: WorkflowStep,
    completedArtifacts: Map<string, string>,
    initialContext: string,
    squad: ParsedSquad,
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: (update: any) => void
  ): Promise<{
    step: WorkflowStep;
    output: string;
    validation: ReturnType<typeof validateStepOutput>;
    attempts: number;
    durationMs: number;
  }> {
    const maxAttempts = step.retryConfig.strategy === "retry"
      ? Math.max(1, step.retryConfig.maxAttempts)
      : 1;
    const delayMs = parseDelay(step.retryConfig.delay);

    let lastOutput = "";
    let lastValidation: ReturnType<typeof validateStepOutput> | null = null;
    const startTime = Date.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Emit agent-start trigger
      emitTrigger(squad, cwd, {
        type: "agent-start",
        agent: step.agentId,
        attempt,
        maxAttempts,
        taskContract: step.taskContract?.name,
      });

      // Log pre-conditions
      if (step.taskContract?.preConditions.length) {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `[${step.agentId}] Pre-conditions: ${step.taskContract.preConditions.length} items` +
                (attempt > 1 ? ` (attempt ${attempt}/${maxAttempts})` : ""),
            },
          ],
        });
      }

      // Build task prompt with full contract
      const prompt = buildTaskPrompt(
        step,
        completedArtifacts,
        initialContext,
        squad.manifest.name
      );

      // Execute
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `[${step.agentId}] Executing${attempt > 1 ? ` (retry ${attempt}/${maxAttempts})` : ""}...`,
          },
        ],
      });

      const output = await spawnSquadAgent(
        step.agent,
        prompt,
        cwd,
        signal,
        (text) =>
          onUpdate?.({
            content: [
              { type: "text", text: `[${step.agentId}] ${text.slice(0, 200)}...` },
            ],
          })
      );

      lastOutput = output;

      // Validate against task contract
      lastValidation = validateStepOutput(output, step.taskContract);

      // Emit task-end trigger
      const stepDuration = Date.now() - startTime;
      emitTrigger(squad, cwd, {
        type: "task-end",
        agent: step.agentId,
        attempt,
        duration: `${Math.round(stepDuration / 1000)}s`,
        validation: lastValidation.summary,
        isError: lastValidation.isError,
        blockersFailed: lastValidation.blockersFailed,
      });

      // Check if we should retry
      if (!lastValidation.isError && !lastValidation.blockersFailed) {
        // Success — no retry needed
        return {
          step,
          output: lastOutput,
          validation: lastValidation,
          attempts: attempt,
          durationMs: Date.now() - startTime,
        };
      }

      // Failed — should we retry?
      if (attempt < maxAttempts) {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `[${step.agentId}] ⚠️ ${lastValidation.summary} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`,
            },
          ],
        });
        if (delayMs > 0) await sleep(delayMs);
      }
    }

    // All attempts exhausted — try fallback if configured
    if (step.retryConfig.strategy === "fallback" && step.retryConfig.fallback) {
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `[${step.agentId}] All attempts failed. Trying fallback: ${step.retryConfig.fallback}`,
          },
        ],
      });

      const fallbackPrompt = buildTaskPrompt(
        { ...step, action: step.retryConfig.fallback },
        completedArtifacts,
        initialContext,
        squad.manifest.name
      );

      const fallbackOutput = await spawnSquadAgent(
        step.agent,
        fallbackPrompt,
        cwd,
        signal
      );

      const fallbackValidation = validateStepOutput(fallbackOutput, step.taskContract);
      return {
        step,
        output: fallbackOutput,
        validation: fallbackValidation,
        attempts: maxAttempts + 1,
        durationMs: Date.now() - startTime,
      };
    }

    return {
      step,
      output: lastOutput,
      validation: lastValidation!,
      attempts: maxAttempts,
      durationMs: Date.now() - startTime,
    };
  }

  // ─── squad_inject ────────────────────────────────────────

  pi.registerTool({
    name: "squad_inject",
    label: "Squad Inject",
    description:
      "Inject a squad artifact (design tokens, strategy doc, copy, etc.) into the GSD .gsd/ context as a research file or decision entry",
    promptSnippet: "Inject squad artifacts into GSD project context",
    promptGuidelines: [
      "Use this to feed squad outputs into the GSD planning/execution pipeline",
      "Artifacts are written to .gsd/milestones/M001/research/ or appended to DECISIONS.md",
      "The GSD state machine will pick them up at the next phase boundary",
    ],
    parameters: Type.Object({
      artifactPath: Type.String({
        description: "Path to the artifact file to inject",
      }),
      targetType: Type.Union(
        [
          Type.Literal("research"),
          Type.Literal("decision"),
          Type.Literal("context"),
        ],
        {
          description:
            'Where to inject: "research" (.gsd/research/), "decision" (append to DECISIONS.md), "context" (inject in next dispatch)',
        }
      ),
      label: Type.Optional(
        Type.String({ description: "Label for the artifact (used as filename for research)" })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd || process.cwd();
      const gsdDir = join(cwd, ".gsd");

      if (!existsSync(params.artifactPath)) {
        return {
          content: [
            { type: "text", text: `Artifact not found: ${params.artifactPath}` },
          ],
          isError: true,
        };
      }

      const content = readFileSync(params.artifactPath, "utf8");
      let targetPath: string;

      switch (params.targetType) {
        case "research": {
          const researchDir = join(gsdDir, "milestones", "M001", "research");
          mkdirSync(researchDir, { recursive: true });
          const filename = params.label
            ? `${params.label.replace(/\s+/g, "-").toLowerCase()}.md`
            : `squad-artifact-${Date.now()}.md`;
          targetPath = join(researchDir, filename);
          writeFileSync(targetPath, content, "utf8");
          break;
        }

        case "decision": {
          targetPath = join(gsdDir, "DECISIONS.md");
          if (existsSync(targetPath)) {
            const existing = readFileSync(targetPath, "utf8");
            writeFileSync(targetPath, existing + "\n" + content, "utf8");
          } else {
            mkdirSync(gsdDir, { recursive: true });
            writeFileSync(targetPath, content, "utf8");
          }
          break;
        }

        case "context": {
          const contextDir = join(gsdDir, "squad-context");
          mkdirSync(contextDir, { recursive: true });
          const filename = params.label
            ? `${params.label.replace(/\s+/g, "-").toLowerCase()}.md`
            : `context-${Date.now()}.md`;
          targetPath = join(contextDir, filename);
          writeFileSync(targetPath, content, "utf8");
          break;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Artifact injected as ${params.targetType}: ${targetPath}`,
          },
        ],
        details: {
          type: params.targetType,
          path: targetPath,
          size: content.length,
        },
      };
    },
  });

  // ─── squad_status ────────────────────────────────────────

  pi.registerTool({
    name: "squad_status",
    label: "Squad Status",
    description: "Show currently loaded squads and activated agents",
    promptSnippet: "Check which squads are currently active",
    parameters: Type.Object({}),
    async execute() {
      if (state.activatedAgents.size === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No squads currently activated. Use squad_activate to load a squad.",
            },
          ],
        };
      }

      const lines = ["Activated squads:\n"];
      for (const [name, agents] of state.activatedAgents) {
        const squad = state.loadedSquads.get(name);
        const taskCount = squad?.tasks.length || 0;
        const wfCount = squad?.workflows.length || 0;
        lines.push(`  ${name} v${squad?.manifest.version || "?"} (${taskCount} tasks, ${wfCount} workflows)`);
        for (const a of agents) {
          const agent = squad?.agents.find(
            (ag) => `squad--${name}--${ag.id}` === a
          );
          lines.push(`    ${agent?.icon || "•"} ${a}: ${agent?.whenToUse || ""}`);
        }
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          squads: [...state.activatedAgents.keys()],
          totalAgents: [...state.activatedAgents.values()].flat().length,
        },
      };
    },
  });

  // ─── Commands ────────────────────────────────────────────

  pi.registerCommand("squad", {
    description:
      "Manage squads — list, activate, run workflows, inject artifacts",
    getArgumentCompletions: (prefix) => {
      const subcommands = [
        { value: "list", label: "List all available squads" },
        { value: "agents", label: "List agents in a squad" },
        { value: "activate", label: "Activate a squad" },
        { value: "run", label: "Run a squad workflow" },
        { value: "inject", label: "Inject artifact into GSD" },
        { value: "status", label: "Show activated squads" },
      ];

      const parts = prefix.split(" ");
      if (parts.length >= 2 && ["activate", "agents", "run"].includes(parts[0])) {
        ensureDiscovered();
        return state.manifests
          .filter((m) => m.name.startsWith(parts[1] || ""))
          .map((m) => ({
            value: `${parts[0]} ${m.name}`,
            label: `${m.name} — ${m.description.slice(0, 50)}`,
          }));
      }

      return subcommands.filter((s) => s.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] || "list";

      switch (subcommand) {
        case "list": {
          ensureDiscovered();
          const filter = parts[1];
          let filtered = state.manifests;
          if (filter) {
            filtered = state.manifests.filter((m) =>
              m.name.toLowerCase().includes(filter.toLowerCase())
            );
          }
          ctx.ui.notify(formatSquadList(filtered), "info");
          break;
        }

        case "agents": {
          const name = parts[1];
          if (!name) {
            ctx.ui.notify("Usage: /squad agents {name}", "warn");
            return;
          }
          ensureDiscovered();
          const manifest = state.manifests.find((m) => m.name === name);
          if (!manifest) {
            ctx.ui.notify(`Squad "${name}" not found.`, "error");
            return;
          }
          const parsed = parseFullSquad(manifest);
          const lines = [`Agents in ${name}:\n`];
          for (const a of parsed.agents) {
            lines.push(`  ${a.icon} ${a.id} — ${a.title}`);
            for (const cmd of a.commands) {
              lines.push(`    ${cmd.name}: ${cmd.description}`);
            }
          }
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "activate": {
          const name = parts[1];
          if (!name) {
            ctx.ui.notify("Usage: /squad activate {name}", "warn");
            return;
          }
          ensureDiscovered();
          const result = activateSquad(name);
          ctx.ui.notify(result, "info");
          await ctx.reload();
          break;
        }

        case "run": {
          const squadName = parts[1];
          const workflowName = parts[2];
          if (!squadName || !workflowName) {
            ctx.ui.notify("Usage: /squad run {squad} {workflow}", "warn");
            return;
          }
          if (!state.loadedSquads.has(squadName)) {
            ctx.ui.notify(
              `Squad "${squadName}" not activated. Run /squad activate ${squadName} first.`,
              "warn"
            );
            return;
          }
          const briefing = await ctx.ui.editor({
            title: `Briefing for ${workflowName}`,
            message: "Provide the initial context/briefing for this workflow:",
          });
          if (!briefing) return;

          pi.sendUserMessage(
            `Use the squad_workflow tool with squad="${squadName}", workflow="${workflowName}", context="${briefing}"`,
            { deliverAs: "steer" }
          );
          break;
        }

        case "inject": {
          const artifactPath = parts[1];
          if (!artifactPath) {
            ctx.ui.notify("Usage: /squad inject {path} [research|decision|context]", "warn");
            return;
          }
          const targetType = (parts[2] || "research") as "research" | "decision" | "context";
          pi.sendUserMessage(
            `Use the squad_inject tool with artifactPath="${artifactPath}", targetType="${targetType}"`,
            { deliverAs: "steer" }
          );
          break;
        }

        case "status": {
          if (state.activatedAgents.size === 0) {
            ctx.ui.notify("No squads currently activated.", "info");
            return;
          }
          const lines = ["Activated squads:\n"];
          for (const [name, agents] of state.activatedAgents) {
            lines.push(`  ${name}: ${agents.length} agents`);
            for (const a of agents) {
              lines.push(`    • ${a}`);
            }
          }
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        default:
          ctx.ui.notify(
            "Usage: /squad [list|agents|activate|run|inject|status]",
            "warn"
          );
      }
    },
  });

  // ─── System Prompt Injection ─────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    const sections: string[] = [
      "\n\n[SQUAD-LOADER — OPERATING RULES]",
      "",
      "squad_* tools are available. Follow these rules every time:",
      "",
      "## RULE 1 — ALWAYS DISCOVER DYNAMICALLY",
      "Squad names vary per installation. NEVER assume or hardcode squad names.",
      "Mandatory sequence before any squad operation:",
      "  1. squad_list → read results → identify the right squad for the task",
      "  2. squad_activate 'exact-name-from-list'",
      "  3. squad_dispatch or squad_workflow using exact agent IDs from activation output",
      "",
      "## RULE 2 — TASK PROMPTS = INSTRUCTIONS, NOT CODE",
      "squad_dispatch 'task' = what the agent should DO. The agent has its own tools.",
      "NEVER paste SQL, TypeScript, file contents, or large text inline.",
      "ALWAYS reference file paths and plan docs instead of duplicating content.",
      "Hard limit: if your task prompt exceeds ~2KB, break it up or reference files.",
      "",
      "Task prompt formula:",
      "  GOAL (1-2 sentences) + CONTEXT (file path or plan doc) + DONE WHEN (one criterion)",
      "",
      "  ✅ GOOD: 'Read .gsd/milestones/M001/slices/S09/S09-PLAN.md T01. Implement the DB",
      "           migration in supabase/migrations/. Run verify-s09.sh when done.'",
      "  ✅ GOOD: 'Review src/lib/admin.ts for auth bypass and injection risks.',",
      "           'Report: file, line, severity, recommended fix.'",
      "  ❌ BAD:  'Implement this migration: CREATE TABLE... [500 lines of SQL]'",
      "  ❌ BAD:  'Create this file: import React... [300 lines of TypeScript]'",
      "",
      "## RULE 3 — SELF-SUPERVISE CONTEXT BUDGET",
      "Before dispatching: if you've accumulated many large tool results, write a handoff",
      "note and stop. A dispatch that starts with a fresh context gives better results.",
      "Signs you must stop: 3+ dispatches done, a dispatch returned '(no output)' or",
      "'(spawn error)', or you were about to paste file contents into a task prompt.",
      "",
      "## RULE 4 — ONE RESPONSIBILITY PER DISPATCH",
      "Each squad_dispatch = one focused goal. Never bundle unrelated tasks.",
      "",
      "## RULE 5 — SQUADS vs DIRECT IMPLEMENTATION",
      "Use squads for: security audit, code review, UX critique, copy/marketing,",
      "  architecture review, domain research.",
      "Implement directly for: routine coding, file edits, bug fixes in known code.",
    ];

    if (state.activatedAgents.size === 0) {
      sections.push("");
      sections.push("No squads currently activated. Call squad_list to discover available squads.");
    } else {
      sections.push("");
      sections.push("Currently activated squads:");
      for (const [name, agents] of state.activatedAgents) {
        const squad = state.loadedSquads.get(name);
        sections.push(`  ${name} (${agents.length} agents):`);
        for (const agentName of agents) {
          const agent = squad?.agents.find(
            (a) => `squad--${name}--${a.id}` === agentName
          );
          if (agent) {
            sections.push(`    ${agent.icon} ${agentName}: ${agent.whenToUse}`);
          }
        }
      }
      sections.push("");
      sections.push(
        "When a task requires domain expertise (design, marketing, copy, pricing, etc.), " +
        "dispatch the appropriate squad agent instead of attempting it yourself."
      );
    }

    // Inject squad-context files
    const cwd = ctx.cwd || process.cwd();
    const contextDir = join(cwd, ".gsd", "squad-context");
    if (existsSync(contextDir)) {
      try {
        const contextFiles = fs.readdirSync(contextDir).filter(
          (f: string) => f.endsWith(".md")
        );
        if (contextFiles.length > 0) {
          sections.push("\n[SQUAD INJECTED CONTEXT]");
          for (const file of contextFiles) {
            const content = readFileSync(join(contextDir, file), "utf8");
            sections.push(`\n--- ${file} ---\n${content}`);
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    return {
      systemPrompt: event.systemPrompt + sections.join("\n"),
    };
  });

  // Auto-discover on startup
  pi.on("session_start", async () => {
    state.manifests = discoverSquads(state.squadsDir);
  });
}
