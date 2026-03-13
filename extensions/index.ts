/**
 * squad-loader — GSD-PI Extension
 *
 * Loads the Squads ecosystem into GSD-PI as native subagents.
 * Squad agents become Pi subagents, squad workflows become chain dispatches,
 * and squad artifacts are injected into the GSD context.
 *
 * Commands:
 *   /squad list              — List all available squads
 *   /squad agents {name}     — List agents in a squad
 *   /squad activate {name}   — Load squad agents into Pi agent cache
 *   /squad run {name} {wf}   — Run a squad workflow as a subagent chain
 *   /squad inject {path}     — Inject artifact into GSD context
 *   /squad status            — Show loaded squads and agents
 *
 * Tools:
 *   squad_list               — List squads (LLM-callable)
 *   squad_activate           — Activate a squad (LLM-callable)
 *   squad_dispatch           — Dispatch a squad agent (LLM-callable)
 *   squad_workflow            — Run a squad workflow chain (LLM-callable)
 *   squad_inject             — Inject artifact into .gsd/ (LLM-callable)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
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
import { adaptSquad, buildWorkflowChain } from "../lib/agent-adapter.js";

// ─── State ───────────────────────────────────────────────────

interface SquadLoaderState {
  squadsDir: string;
  manifests: SquadManifest[];
  loadedSquads: Map<string, ParsedSquad>;
  activatedAgents: Map<string, string[]>; // squad name → pi agent names
  agentsCacheDir: string;
}

const state: SquadLoaderState = {
  squadsDir: "",
  manifests: [],
  loadedSquads: new Map(),
  activatedAgents: new Map(),
  agentsCacheDir: "",
};

// ─── Helper ──────────────────────────────────────────────────

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

  // Parse full squad
  const parsed = parseFullSquad(manifest);
  state.loadedSquads.set(name, parsed);

  // Adapt agents to Pi format and write to cache
  const adapted = adaptSquad(parsed, state.agentsCacheDir);
  const agentNames = adapted.map((a) => a.piName);
  state.activatedAgents.set(name, agentNames);

  const lines = [
    `Squad "${name}" activated with ${adapted.length} agents:\n`,
    ...adapted.map(
      (a) => `  ${a.source.icon} ${a.piName} — ${a.source.title}`
    ),
    "",
    `Agents written to: ${state.agentsCacheDir}`,
    "",
    "These agents are now available as subagents.",
    'Use the subagent tool to dispatch them, e.g.:',
    `  { "agent": "${agentNames[0]}", "task": "..." }`,
  ];

  if (parsed.workflows.length > 0) {
    lines.push("");
    lines.push("Available workflows:");
    for (const wf of parsed.workflows) {
      lines.push(`  ${wf.name} — ${wf.description.slice(0, 80)}`);
    }
  }

  return lines.join("\n");
}

// ─── Extension Entry Point ───────────────────────────────────

export default function squadLoader(pi: ExtensionAPI) {
  // Resolve squads directory
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  state.squadsDir = resolve(homeDir, "squads");
  state.agentsCacheDir = resolve(homeDir, ".gsd", "agent", "agents");

  // Ensure agents cache dir exists
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
    async execute(toolCallId, params, signal, onUpdate, ctx) {
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
    async execute(toolCallId, params, signal, onUpdate, ctx) {
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

  pi.registerTool({
    name: "squad_dispatch",
    label: "Squad Dispatch",
    description:
      "Dispatch a specific squad agent to perform a task. The agent runs as an isolated subagent with its full persona, principles, and task knowledge.",
    promptSnippet: "Dispatch a squad agent to perform specialized work",
    promptGuidelines: [
      "The squad must be activated first via squad_activate",
      "Provide the full agent ID: squad--{squad-name}--{agent-id}",
      // --- HOW TO WRITE EFFECTIVE TASK PROMPTS ---
      "TASK PROMPT = INSTRUCTIONS, NOT CODE. Write what the agent should DO, not the implementation itself.",
      "The agent has its own tools (read, write, edit, bash, search) — it reads files and implements by itself.",
      "Reference file paths instead of pasting file contents: e.g. 'Read src/lib/billing.ts and add Stripe Connect functions as described in .gsd/milestones/M001/slices/S09/S09-PLAN.md T02'",
      "Reference plan docs instead of duplicating specs: e.g. 'Implement T01 from S09-PLAN.md — DB migration for multi-tenant'",
      "Keep task prompts SHORT and DIRECTIVE: WHO does WHAT, WHERE to find context, WHAT success looks like",
      // --- ANTI-PATTERNS ---
      "NEVER paste SQL migrations, TypeScript code, or full file contents inline in the task prompt",
      "NEVER duplicate content that already exists in plan files (.gsd/milestones/) or docs",
      "NEVER send multiple large tasks in a single dispatch — break into focused single-responsibility tasks",
      "NEVER use squads for tasks you can implement directly — use them for domain expertise (design, copy, security audit, architecture review)",
      // --- GOOD EXAMPLES ---
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
      // Verify agent exists
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

      // Guard: task prompt size check.
      // Large prompts (code/SQL pasted inline) cause spawn ARG_MAX failures and poor agent results.
      const TASK_WARN_BYTES = 4_096;   // 4KB — warn
      const TASK_HARD_BYTES = 16_384;  // 16KB — reject (well below macOS ARG_MAX, leaves room for extensions)
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
                "Instead of pasting content, reference the file path:",
                "  ✅ 'Read src/lib/billing.ts and implement the Stripe Connect functions described in .gsd/milestones/M001/slices/S09/S09-PLAN.md T02'",
                "  ❌ 'Implement this file: [3000 lines of TypeScript pasted here]'",
                "",
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

      let taskPrompt = params.task;
      if (params.context) {
        taskPrompt = `## Context from previous agent\n${params.context}\n\n## Your Task\n${params.task}`;
      }

      // Read agent file to extract model, tools, and system prompt.
      // Uses proper frontmatter parsing (matching subagent extension's approach).
      let agentModel: string | undefined;
      let agentTools: string[] = [];
      let agentSystemPrompt = "";
      try {
        const agentContent = readFileSync(agentPath, "utf8");
        const fmMatch = agentContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        if (fmMatch) {
          const fmBlock = fmMatch[1];
          agentSystemPrompt = fmMatch[2];
          // Parse YAML frontmatter properly (handles multi-line values)
          try {
            const parsed = (await import("js-yaml")).default.load(fmBlock) as Record<string, any>;
            if (parsed) {
              if (parsed.model) agentModel = String(parsed.model);
              if (parsed.tools) {
                agentTools = String(parsed.tools).split(",").map((t: string) => t.trim()).filter(Boolean);
              }
            }
          } catch {
            // Fallback: line-by-line regex
            for (const line of fmBlock.split("\n")) {
              const modelMatch = line.match(/^model:\s*(.+)$/);
              if (modelMatch) agentModel = modelMatch[1].trim();
              const toolsMatch = line.match(/^tools:\s*(.+)$/);
              if (toolsMatch) agentTools = toolsMatch[1].split(",").map((t: string) => t.trim()).filter(Boolean);
            }
          }
        }
      } catch {
        // fallback: dispatch anyway with defaults
      }

      onUpdate?.({
        content: [{ type: "text", text: `Dispatching ${params.agent}...` }],
        details: { agent: params.agent, task: params.task },
      });

      // Spawn the subagent process — using the same pattern as the working `subagent` extension.
      // Key: pass ALL bundled extensions (do NOT filter), proper JSON event tracking.
      const output = await new Promise<string>((resolve) => {
        const args: string[] = ["--mode", "json", "-p", "--no-session"];
        if (agentModel) args.push("--model", agentModel);
        if (agentTools.length > 0) args.push("--tools", agentTools.join(","));

        // Write system prompt to temp file
        let tmpDir: string | null = null;
        let tmpPath: string | null = null;
        if (agentSystemPrompt.trim()) {
          tmpDir = fs.mkdtempSync(join(os.tmpdir(), "squad-dispatch-"));
          tmpPath = join(tmpDir, `${params.agent}.md`);
          fs.writeFileSync(tmpPath, agentSystemPrompt, { encoding: "utf-8", mode: 0o600 });
          args.push("--append-system-prompt", tmpPath);
        }

        args.push(`Task: ${taskPrompt}`);

        // Pass ALL bundled extensions — same as the subagent extension.
        // Filtering caused silent failures when needed extensions were missing.
        const bundledPaths = (process.env.GSD_BUNDLED_EXTENSION_PATHS ?? "").split(":").filter(Boolean);
        const extensionArgs = bundledPaths.flatMap(p => ["--extension", p]);

        const proc = spawn(
          process.execPath,
          [process.env.GSD_BIN_PATH!, ...extensionArgs, ...args],
          { cwd: ctx.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] }
        );

        let buffer = "";
        let finalOutput = "";
        let stderr = "";
        let turns = 0;

        const processLine = (line: string) => {
          if (!line.trim()) return;
          let event: any;
          try { event = JSON.parse(line); } catch { return; }

          // Track message_end events (same pattern as subagent extension)
          if (event.type === "message_end" && event.message) {
            const msg = event.message;
            if (msg.role === "assistant") {
              turns++;
              for (const part of msg.content ?? []) {
                if (part.type === "text") {
                  finalOutput = part.text;
                  onUpdate?.({
                    content: [{ type: "text", text: finalOutput }],
                    details: { agent: params.agent, task: params.task, turns },
                  });
                }
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

        proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

        proc.on("close", (code) => {
          // Process remaining buffer
          if (buffer.trim()) processLine(buffer);

          // Cleanup temp files
          try { if (tmpPath) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          try { if (tmpDir) fs.rmdirSync(tmpDir); } catch { /* ignore */ }

          // Structured error reporting when spawn fails
          if (!finalOutput) {
            if (code !== 0) {
              resolve(`[squad-dispatch] Agent exited with code ${code}.\n${stderr ? `stderr: ${stderr.trim()}` : "(no stderr)"}`);
            } else if (turns === 0) {
              resolve(`[squad-dispatch] Agent produced no output (0 turns). This usually means the agent file is malformed or auth failed.\n${stderr ? `stderr: ${stderr.trim()}` : ""}`);
            } else {
              resolve("(no text output from agent)");
            }
          } else {
            resolve(finalOutput);
          }
        });

        proc.on("error", (err) => resolve(`[squad-dispatch] Spawn error: ${err.message}`));

        // Honor abort signal
        if (signal) {
          const kill = () => { proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000); };
          if (signal.aborted) kill();
          else signal.addEventListener("abort", kill, { once: true });
        }
      });

      return {
        content: [{ type: "text", text: output }],
        details: { agent: params.agent, task: params.task },
      };
    },
  });

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
            text: `Building workflow chain for "${params.workflow}"...`,
          },
        ],
      });

      const chain = buildWorkflowChain(parsed, params.workflow);
      if (!chain || chain.length === 0) {
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

      // Inject initial context into first step
      chain[0].task = `## Initial Context\n${params.context}\n\n## Task\n${chain[0].task}`;

      // Helper: spawn one agent directly (matches subagent extension pattern)
      const spawnAgent = async (agentName: string, taskPrompt: string): Promise<string> => {
        const agentPath = join(state.agentsCacheDir, `${agentName}.md`);
        if (!existsSync(agentPath)) return `[squad-workflow] Agent ${agentName} not found in cache.`;

        let agentModel: string | undefined;
        let agentTools: string[] = [];
        let agentSystemPrompt = "";
        try {
          const agentContent = readFileSync(agentPath, "utf8");
          const fmMatch = agentContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
          if (fmMatch) {
            const fmBlock = fmMatch[1];
            agentSystemPrompt = fmMatch[2];
            try {
              const parsed = (await import("js-yaml")).default.load(fmBlock) as Record<string, any>;
              if (parsed) {
                if (parsed.model) agentModel = String(parsed.model);
                if (parsed.tools) agentTools = String(parsed.tools).split(",").map((t: string) => t.trim()).filter(Boolean);
              }
            } catch {
              for (const line of fmBlock.split("\n")) {
                const modelMatch = line.match(/^model:\s*(.+)$/);
                if (modelMatch) agentModel = modelMatch[1].trim();
                const toolsMatch = line.match(/^tools:\s*(.+)$/);
                if (toolsMatch) agentTools = toolsMatch[1].split(",").map((t: string) => t.trim()).filter(Boolean);
              }
            }
          }
        } catch { /* ignore */ }

        return new Promise<string>((resolve) => {
          const args: string[] = ["--mode", "json", "-p", "--no-session"];
          if (agentModel) args.push("--model", agentModel);
          if (agentTools.length > 0) args.push("--tools", agentTools.join(","));

          let tmpDir: string | null = null;
          let tmpPath: string | null = null;
          if (agentSystemPrompt.trim()) {
            tmpDir = fs.mkdtempSync(join(os.tmpdir(), "squad-wf-"));
            tmpPath = join(tmpDir, `${agentName}.md`);
            fs.writeFileSync(tmpPath, agentSystemPrompt, { encoding: "utf-8", mode: 0o600 });
            args.push("--append-system-prompt", tmpPath);
          }

          args.push(`Task: ${taskPrompt}`);

          // Pass ALL bundled extensions — no filtering
          const bundledPaths = (process.env.GSD_BUNDLED_EXTENSION_PATHS ?? "").split(":").filter(Boolean);
          const extensionArgs = bundledPaths.flatMap(p => ["--extension", p]);

          const proc = spawn(
            process.execPath,
            [process.env.GSD_BIN_PATH!, ...extensionArgs, ...args],
            { cwd: ctx.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] }
          );

          let buffer = "";
          let finalOutput = "";
          let stderr = "";
          let turns = 0;

          const processLine = (line: string) => {
            if (!line.trim()) return;
            let event: any;
            try { event = JSON.parse(line); } catch { return; }
            if (event.type === "message_end" && event.message?.role === "assistant") {
              turns++;
              for (const part of event.message.content ?? []) {
                if (part.type === "text") finalOutput = part.text;
              }
            }
          };

          proc.stdout.on("data", (data: Buffer) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) processLine(line);
          });

          proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

          proc.on("close", (code) => {
            if (buffer.trim()) processLine(buffer);
            try { if (tmpPath) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            try { if (tmpDir) fs.rmdirSync(tmpDir); } catch { /* ignore */ }

            if (!finalOutput) {
              if (code !== 0) resolve(`[squad-workflow] Agent ${agentName} exited with code ${code}.\n${stderr ? stderr.trim() : "(no stderr)"}`);
              else if (turns === 0) resolve(`[squad-workflow] Agent ${agentName} produced no output (0 turns).\n${stderr ? stderr.trim() : ""}`);
              else resolve("(no text output)");
            } else {
              resolve(finalOutput);
            }
          });

          proc.on("error", (err) => resolve(`[squad-workflow] Spawn error for ${agentName}: ${err.message}`));

          if (signal) {
            const kill = () => { proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000); };
            if (signal.aborted) kill();
            else signal.addEventListener("abort", kill, { once: true });
          }
        });
      };

      // Execute chain sequentially: each step gets previous output
      const results: { agent: string; output: string }[] = [];
      let previousOutput = "";

      for (let i = 0; i < chain.length; i++) {
        const step = chain[i];
        const taskWithPrevious = step.task.replace(/\{previous\}/g, previousOutput);

        onUpdate?.({
          content: [{ type: "text", text: `Step ${i + 1}/${chain.length}: ${step.agent}...` }],
          details: { squad: params.squad, workflow: params.workflow, steps: chain.length, agents: chain.map(s => s.agent) },
        });

        const output = await spawnAgent(step.agent, taskWithPrevious);
        results.push({ agent: step.agent, output });
        previousOutput = output;
      }

      const finalSummary = results
        .map((r, i) => `### Step ${i + 1}: ${r.agent}\n${r.output}`)
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: finalSummary }],
        details: {
          squad: params.squad,
          workflow: params.workflow,
          steps: chain.length,
          agents: chain.map((s) => s.agent),
        },
      };
    },
  });

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
          // Store as context that will be injected in next before_agent_start
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
        lines.push(`  ${name} v${squad?.manifest.version || "?"}`);
        for (const a of agents) {
          const agent = squad?.agents.find(
            (ag) => `squad--${name}--${ag.id}` === a
          );
          lines.push(`    ${agent?.icon || "•"} ${a}`);
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

      // If prefix starts with a subcommand + space, complete squad names
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
          // Reload so Pi discovers the new agent files
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
          // Prompt user for context/briefing
          const briefing = await ctx.ui.editor({
            title: `Briefing for ${workflowName}`,
            message: "Provide the initial context/briefing for this workflow:",
          });
          if (!briefing) return;

          pi.sendUserMessage(
            `Use the squad_workflow tool with squad="${squadName}", workflow="${workflowName}", context="${briefing}"`,
            { mode: "steer" }
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
            { mode: "steer" }
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

  // ─── Event Hooks ─────────────────────────────────────────

  /**
   * Inject squad operating rules into the agent's system prompt.
   * Always injected (even with no squads active) so the agent knows the correct
   * approach BEFORE it attempts any squad operation. When squads are already
   * activated the section is extended with agent inventory.
   */
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

    // Inject any squad-context files from .gsd/squad-context/
    const cwd = ctx.cwd || process.cwd();
    const contextDir = join(cwd, ".gsd", "squad-context");
    if (existsSync(contextDir)) {
      try {
        const contextFiles = (await import("fs")).readdirSync(contextDir).filter(
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

  /**
   * Auto-discover squads on startup
   */
  pi.on("session_start", async () => {
    state.manifests = discoverSquads(state.squadsDir);
    if (state.manifests.length > 0) {
      // Set status line showing available squads
      // (ctx not available here, but we store for later use)
    }
  });
}
