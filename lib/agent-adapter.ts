/**
 * agent-adapter.ts — v3
 *
 * Converts squad agent definitions into Pi SDK agent format.
 * v3 additions:
 *   - Self-verify checklist injection into agent system prompt
 *   - Filesystem collaboration awareness (read/write artifacts from disk)
 *   - Phase annotation for reasoning sandwich model routing
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import type {
  SquadAgent, SquadTask, ParsedSquad, SquadWorkflow,
  V2WorkflowStep, ModelStrategy
} from "./squad-parser.js";

// ─── Types ───────────────────────────────────────────────────

export interface PiAgentFile {
  path: string;
  piName: string;
  source: SquadAgent;
  content: string;
}

export interface WorkflowChainStep {
  agent: string;
  task: string;
  model?: string;
  v2Step?: V2WorkflowStep;
}

// ─── Tool Inference ──────────────────────────────────────────

function inferTools(agent: SquadAgent): string[] {
  const base = ["read", "grep", "bash", "write", "edit"];
  const role = `${agent.role} ${agent.focus} ${agent.identity}`.toLowerCase();

  if (role.includes("research") || role.includes("analysis") ||
      role.includes("market") || role.includes("web")) {
    base.push("web_search");
  }
  if (role.includes("design") || role.includes("visual") ||
      role.includes("brand") || role.includes("ui")) {
    base.push("browser");
  }
  return [...new Set(base)];
}

// ─── System Prompt Builder ───────────────────────────────────

function buildSystemPrompt(agent: SquadAgent, tasks: SquadTask[]): string {
  const sections: string[] = [];
  const nameDisplay = [agent.icon, agent.name, agent.title].filter(Boolean).join(" — ") || agent.id;
  sections.push(`# ${nameDisplay}`);
  sections.push("");

  if (agent.role) {
    sections.push(`You are a **${agent.role}** from the "${agent.squadName}" squad.`);
  } else {
    sections.push(`You are a specialist agent from the "${agent.squadName}" squad.`);
  }

  if (agent.identity) sections.push(agent.identity);
  if (agent.style) sections.push(`Communication style: ${agent.style}`);
  sections.push("");

  if (agent.focus) {
    sections.push("## Focus");
    sections.push(agent.focus);
    sections.push("");
  }

  if (agent.corePrinciples.length > 0) {
    sections.push("## Principles (Non-Negotiable)");
    for (const p of agent.corePrinciples) sections.push(`- ${p}`);
    sections.push("");
  }

  if (agent.responsibilityBoundaries.length > 0) {
    sections.push("## Responsibility Boundaries");
    for (const b of agent.responsibilityBoundaries) sections.push(`- ${b}`);
    sections.push("");
  }

  if (agent.contextBudget > 0) {
    sections.push("## Context Budget");
    sections.push(`Your output should stay within ~${agent.contextBudget} tokens. Be concise and structured.`);
    sections.push("");
  }

  sections.push("## How to Execute");
  sections.push("");
  sections.push("When you receive a task:");
  sections.push("1. Read the task contract carefully — inputs, expected outputs, and acceptance criteria");
  sections.push("2. Use your tools (read, bash, grep, write, edit) to analyze files and produce outputs");
  sections.push("3. Write output artifacts to the specified directory");
  sections.push("4. Self-validate against EVERY post-condition and acceptance criterion before finishing");
  sections.push("5. Report structured results (see Output Format below)");
  sections.push("");

  // Task specifications
  if (tasks.length > 0) {
    sections.push("## Task Specifications");
    sections.push("");
    for (const task of tasks) {
      sections.push(`### ${task.name}`);

      if (task.entrada.length > 0) {
        sections.push("**Inputs:**");
        for (const e of task.entrada) {
          const req = e.obrigatorio ? "required" : "optional";
          sections.push(`- \`${e.nome}\` (${e.tipo}, ${req}): ${e.descricao}`);
        }
      }
      if (task.saida.length > 0) {
        sections.push("**Expected outputs:**");
        for (const s of task.saida) {
          const req = s.obrigatorio ? "MUST produce" : "optional";
          sections.push(`- \`${s.nome}\` (${s.tipo}, ${req}): ${s.descricao}`);
        }
      }
      if (task.outputSchema) {
        sections.push(`**Output schema:** \`${task.outputSchema}\` — your JSON output MUST conform to this schema.`);
      }
      if (task.assertions.length > 0) {
        sections.push("**Validation assertions (must ALL pass):**");
        for (const a of task.assertions) sections.push(`- \`${a}\``);
      }

      if (task.postConditions.length > 0) {
        sections.push("**Post-conditions (validate each one):**");
        for (const c of task.postConditions) sections.push(`- ${c}`);
      }
      if (task.acceptanceCriteria.length > 0) {
        sections.push("**Acceptance criteria:**");
        for (const ac of task.acceptanceCriteria) {
          const prefix = ac.blocker ? "🚫 BLOCKER" : "⚠️ DESIRED";
          sections.push(`- [${prefix}] ${ac.criteria}`);
        }
      }
      if (task.content.trim()) {
        sections.push("");
        sections.push(task.content.trim());
      }
      sections.push("");
    }
  }

  // Agent body
  if (agent.fullContent.trim()) {
    const body = agent.fullContent.trim();
    if (body.length > 50) {
      sections.push("## Additional Context");
      sections.push("");
      sections.push(body);
      sections.push("");
    }
  }

  // Output format
  sections.push("## Output Format");
  sections.push("");
  sections.push("You MUST end your response with this exact validation block:");
  sections.push("```");
  sections.push("## Validation Report");
  sections.push("- [PASS] criterion description");
  sections.push("- [PASS] criterion description");
  sections.push("- [FAIL] criterion description — reason");
  sections.push("```");
  sections.push("");
  sections.push("Before the validation block, include:");
  sections.push("1. **Summary** — what was done and key metrics");
  sections.push("2. **Artifacts Created** — file paths and descriptions");
  sections.push("");
  sections.push("If your task requires JSON output, output the JSON FIRST, then the validation block.");

  return sections.join("\n");
}

// ─── Agent Adapter ───────────────────────────────────────────

export function adaptAgent(agent: SquadAgent, tasks: SquadTask[]): PiAgentFile {
  const piName = `squad--${agent.squadName}--${agent.id}`;
  const tools = inferTools(agent);

  const agentTasks = tasks.filter(
    (t) =>
      t.agent === agent.name ||
      agent.taskFiles.some((f) => t.filePath.endsWith(f))
  );

  const systemPrompt = buildSystemPrompt(agent, agentTasks);

  const frontmatter = [
    "---",
    `name: ${piName}`,
    `description: "${agent.icon} ${agent.title} — ${agent.whenToUse}"`,
    `tools: ${tools.join(", ")}`,
  ];

  if (agent.model) {
    frontmatter.push(`model: ${agent.model}`);
  }

  frontmatter.push("---");

  const content = frontmatter.join("\n") + "\n\n" + systemPrompt;

  return {
    path: "",
    piName,
    source: agent,
    content,
  };
}

export function adaptSquad(squad: ParsedSquad, outputDir: string): PiAgentFile[] {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const adapted: PiAgentFile[] = [];
  for (const agent of squad.agents) {
    const piAgent = adaptAgent(agent, squad.tasks);
    piAgent.path = join(outputDir, `${piAgent.piName}.md`);
    writeFileSync(piAgent.path, piAgent.content, "utf8");
    adapted.push(piAgent);
  }
  return adapted;
}

// ─── Workflow Chain Building ─────────────────────────────────

export function buildWorkflowChain(
  squad: ParsedSquad,
  workflowName: string
): WorkflowChainStep[] | null {
  const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  const target = normalize(workflowName);
  const workflow = squad.workflows.find(
    (w) =>
      normalize(w.name) === target ||
      normalize(w.name).includes(target) ||
      target.includes(normalize(w.name))
  );

  if (!workflow) return null;

  const chain: WorkflowChainStep[] = [];

  if (workflow.isV2 && workflow.v2Sequence.length > 0) {
    for (let i = 0; i < workflow.v2Sequence.length; i++) {
      const step = workflow.v2Sequence[i];

      if (step.type === "human-gate") {
        chain.push({
          agent: "__human-gate__",
          task: step.prompt || "",
          v2Step: step,
        });
      } else {
        const agent = squad.agents.find(
          (a) => a.id === step.agent || a.id.endsWith(step.agent!)
        );
        if (!agent) continue;

        const piName = `squad--${squad.manifest.name}--${agent.id}`;
        const taskPrompt = i === 0
          ? step.action || ""
          : `Based on previous pipeline output:\n{previous}\n\n${step.action || ""}`;

        const model = step.model || agent.model || undefined;

        chain.push({
          agent: piName,
          task: taskPrompt,
          model,
          v2Step: step,
        });
      }
    }
  } else {
    // v1 chain
    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const agent = squad.agents.find(
        (a) => a.id === step.agent || a.id.endsWith(step.agent)
      );
      if (!agent) continue;

      const piName = `squad--${squad.manifest.name}--${agent.id}`;
      const taskPrompt = i === 0
        ? `Execute: ${step.action}`
        : `Based on previous output:\n{previous}\n\nExecute: ${step.action}`;

      chain.push({
        agent: piName,
        task: taskPrompt,
      });
    }
  }

  return chain;
}

// ─── Dispatch Prompt Builder ─────────────────────────────────

export function buildDispatchPrompt(
  userTask: string,
  agentTasks: SquadTask[],
  context?: string,
  modelPreference?: string
): string {
  const sections: string[] = [];

  if (modelPreference) {
    sections.push(`[MODEL PREFERENCE: ${modelPreference}]`);
    sections.push("");
  }

  if (context) {
    sections.push("## Context from previous agent");
    sections.push(context);
    sections.push("");
  }

  sections.push("## Your Task");
  sections.push(userTask);
  sections.push("");

  if (agentTasks.length > 0) {
    for (const task of agentTasks) {
      sections.push(`## Task Contract: ${task.name}`);
      sections.push("");

      if (task.entrada.length > 0) {
        sections.push("### Inputs");
        for (const e of task.entrada) {
          const req = e.obrigatorio ? "required" : "optional";
          sections.push(`- **${e.nome}** (${e.tipo}, ${req}): ${e.descricao}`);
        }
        sections.push("");
      }

      if (task.saida.length > 0) {
        sections.push("### Expected Outputs");
        for (const s of task.saida) {
          const req = s.obrigatorio ? "🔴 REQUIRED" : "⚪ optional";
          sections.push(`- **${s.nome}** (${s.tipo}, ${req}): ${s.descricao}`);
        }
        sections.push("");
      }

      if (task.outputSchema) {
        sections.push(`### Output Schema`);
        sections.push(`Your JSON output MUST conform to: \`${task.outputSchema}\``);
        sections.push("");
      }
      if (task.assertions.length > 0) {
        sections.push("### Validation Assertions");
        sections.push("These JavaScript expressions MUST evaluate to true against your output:");
        for (const a of task.assertions) sections.push(`- \`${a}\``);
        sections.push("");
      }

      if (task.preConditions.length > 0) {
        sections.push("### Pre-conditions");
        for (const c of task.preConditions) sections.push(`- ${c}`);
        sections.push("");
      }
      if (task.postConditions.length > 0) {
        sections.push("### Post-conditions (Self-Validate)");
        for (const c of task.postConditions) sections.push(`- ${c}`);
        sections.push("");
      }
      if (task.acceptanceCriteria.length > 0) {
        sections.push("### Acceptance Criteria");
        for (const ac of task.acceptanceCriteria) {
          const prefix = ac.blocker ? "🚫 BLOCKER" : "⚠️ DESIRED";
          sections.push(`- [${prefix}] ${ac.criteria}`);
        }
        sections.push("");
      }
    }
  }

  return sections.join("\n");
}

// ─── Output Validation ───────────────────────────────────────

export interface StepValidation {
  passed: string[];
  failed: string[];
  blockersFailed: boolean;
  isError: boolean;
  summary: string;
}

export function validateStepOutput(output: string, tasks: SquadTask[]): StepValidation {
  const passed: string[] = [];
  const failed: string[] = [];

  const isSpawnError = output.startsWith("[squad-agent]") ||
    output === "(no text output)" || output.trim() === "";

  if (isSpawnError) {
    return { passed: [], failed: ["Agent produced no usable output"], blockersFailed: true, isError: true, summary: `❌ Agent error: ${output.slice(0, 200)}` };
  }

  if (tasks.length === 0) {
    return { passed: ["Output produced"], failed: [], blockersFailed: false, isError: false, summary: "✅ Output received (no task contract to validate against)" };
  }

  const validationMatch = output.match(/##\s*Validation Report[\s\S]*?((?:\s*-\s*\[(PASS|FAIL)\]\s*.+)+)/i);
  if (validationMatch) {
    for (const line of validationMatch[1].split("\n").filter((l) => l.trim())) {
      const m = line.match(/\[(PASS|FAIL)\]\s*(.+)/i);
      if (m) {
        (m[1].toUpperCase() === "PASS" ? passed : failed).push(m[2].trim());
      }
    }
  }

  let blockersFailed = false;
  for (const task of tasks) {
    for (const ac of task.acceptanceCriteria) {
      if (!ac.blocker) continue;
      if (failed.some((f) => f.toLowerCase().includes(ac.criteria.toLowerCase().slice(0, 30)))) {
        blockersFailed = true;
      }
    }
  }

  const total = passed.length + failed.length;
  const summary = total === 0
    ? "⚠️ No validation report found"
    : blockersFailed
      ? `❌ ${passed.length}/${total} passed — BLOCKER FAILED`
      : `✅ ${passed.length}/${total} passed`;

  return { passed, failed, blockersFailed, isError: false, summary };
}
