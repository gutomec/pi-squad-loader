/**
 * agent-adapter.ts
 *
 * Converts squad agent definitions into Pi SDK agent format.
 * Builds task-aware prompts that include full task contracts
 * (inputs, outputs, pre/post conditions, acceptance criteria).
 *
 * Key functions:
 *   adaptSquad()           — write Pi-compatible .md agent files
 *   buildWorkflowPlan()    — plan workflow with dependency graph
 *   buildTaskPrompt()      — prompt for workflow step (with contract)
 *   resolveAgentTasks()    — find tasks for a given agent
 *   buildDispatchPrompt()  — prompt for single dispatch (with contract)
 *   validateStepOutput()   — check agent output against task contract
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { SquadAgent, SquadTask, ParsedSquad } from "./squad-parser.js";

// ─── Types ───────────────────────────────────────────────────

export interface PiAgentFile {
  path: string;
  piName: string;
  source: SquadAgent;
  content: string;
}

export interface TaskContract {
  name: string;
  inputs: { nome: string; tipo: string; obrigatorio: boolean; descricao: string }[];
  outputs: { nome: string; tipo: string; obrigatorio: boolean; descricao: string }[];
  preConditions: string[];
  postConditions: string[];
  acceptanceCriteria: { blocker: boolean; criteria: string }[];
  content: string;
}

export interface WorkflowStep {
  agent: string;        // Pi agent name: squad--{name}--{id}
  agentId: string;      // Original agent ID
  action: string;       // Human description of what to do
  creates: string;      // Artifact name this step produces
  requires: string[];   // Artifact names this step needs
  taskContract: TaskContract | null;
  retryConfig: { strategy: string; maxAttempts: number; delay: string; fallback: string };
  skippableWhen: string;
}

export interface WorkflowPlan {
  steps: WorkflowStep[];
  name: string;
  description: string;
}

export interface StepValidation {
  passed: string[];
  failed: string[];
  blockersFailed: boolean;
  isError: boolean;
  summary: string;
}

// ─── Tool mapping ────────────────────────────────────────────

function inferTools(agent: SquadAgent): string[] {
  const base = ["read", "grep", "bash", "write", "edit"];
  const role = `${agent.role} ${agent.focus} ${agent.identity}`.toLowerCase();

  if (
    role.includes("research") ||
    role.includes("analysis") ||
    role.includes("market") ||
    role.includes("competitor") ||
    role.includes("web")
  ) {
    base.push("web_search");
  }

  if (
    role.includes("design") ||
    role.includes("visual") ||
    role.includes("brand") ||
    role.includes("ui") ||
    role.includes("render")
  ) {
    base.push("browser");
  }

  return [...new Set(base)];
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
    "---",
  ];

  const content = frontmatter.join("\n") + "\n\n" + systemPrompt;

  return {
    path: "",
    piName,
    source: agent,
    content,
  };
}

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
    for (const p of agent.corePrinciples) {
      sections.push(`- ${p}`);
    }
    sections.push("");
  }

  if (agent.responsibilityBoundaries.length > 0) {
    sections.push("## Responsibility Boundaries");
    for (const b of agent.responsibilityBoundaries) {
      sections.push(`- ${b}`);
    }
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
      if (task.postConditions.length > 0) {
        sections.push("**Post-conditions (validate each one):**");
        for (const c of task.postConditions) {
          sections.push(`- ${c}`);
        }
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

  if (agent.fullContent.trim()) {
    const body = agent.fullContent.trim();
    if (body.length > 50 && !body.startsWith("agent:") && !body.startsWith("persona:")) {
      sections.push("## Additional Context");
      sections.push("");
      sections.push(body);
      sections.push("");
    }
  }

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

  return sections.join("\n");
}

export function adaptSquad(
  squad: ParsedSquad,
  outputDir: string
): PiAgentFile[] {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const adapted: PiAgentFile[] = [];

  for (const agent of squad.agents) {
    const piAgent = adaptAgent(agent, squad.tasks);
    piAgent.path = join(outputDir, `${piAgent.piName}.md`);
    writeFileSync(piAgent.path, piAgent.content, "utf8");
    adapted.push(piAgent);
  }

  return adapted;
}

// ─── Task Resolution ─────────────────────────────────────────

/**
 * Find all tasks assigned to a given agent.
 * Matches by: agent display name, task file dependency, or agent ID suffix.
 */
export function resolveAgentTasks(squad: ParsedSquad, agentPiName: string): SquadTask[] {
  const agent = squad.agents.find(
    (a) => `squad--${squad.manifest.name}--${a.id}` === agentPiName
  );
  if (!agent) return [];

  return squad.tasks.filter(
    (t) =>
      t.agent === agent.name ||
      agent.taskFiles.some((f) => t.filePath.endsWith(f)) ||
      t.agent.toLowerCase().includes(agent.id.replace(/^[^-]+-/, "").toLowerCase())
  );
}

/**
 * Build an enriched dispatch prompt that includes the formal task contract.
 * Used by squad_dispatch for single-agent dispatches.
 */
export function buildDispatchPrompt(
  userTask: string,
  agentTasks: SquadTask[],
  context?: string
): string {
  const sections: string[] = [];

  if (context) {
    sections.push("## Context from previous agent");
    sections.push(context);
    sections.push("");
  }

  sections.push("## Your Task");
  sections.push(userTask);
  sections.push("");

  // If agent has tasks, inject the most relevant contract
  if (agentTasks.length > 0) {
    // If single task, always include it. If multiple, include all (agent decides).
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
        sections.push("You MUST produce these artifacts:");
        for (const s of task.saida) {
          const req = s.obrigatorio ? "🔴 REQUIRED" : "⚪ optional";
          sections.push(`- **${s.nome}** (${s.tipo}, ${req}): ${s.descricao}`);
        }
        sections.push("");
      }

      if (task.preConditions.length > 0) {
        sections.push("### Pre-conditions");
        sections.push("Verify these are true before starting:");
        for (const c of task.preConditions) {
          sections.push(`- ${c}`);
        }
        sections.push("");
      }

      if (task.postConditions.length > 0) {
        sections.push("### Post-conditions (Self-Validate)");
        sections.push("Each must be TRUE when you finish:");
        for (const c of task.postConditions) {
          sections.push(`- ${c}`);
        }
        sections.push("");
      }

      if (task.acceptanceCriteria.length > 0) {
        sections.push("### Acceptance Criteria");
        for (const ac of task.acceptanceCriteria) {
          const prefix = ac.blocker ? "🚫 BLOCKER — must pass" : "⚠️ DESIRED — should pass";
          sections.push(`- [${prefix}] ${ac.criteria}`);
        }
        sections.push("");
      }
    }
  }

  return sections.join("\n");
}

// ─── Output Validation ───────────────────────────────────────

/**
 * Validate an agent's output against its task contract.
 *
 * Checks:
 * 1. Is the output empty or an error? → isError
 * 2. Did the agent produce a Validation Report? → parse PASS/FAIL
 * 3. Are required outputs mentioned? → check output text
 * 4. Are blocker criteria reported as FAIL? → blockersFailed
 */
export function validateStepOutput(
  output: string,
  taskContract: TaskContract | null
): StepValidation {
  const passed: string[] = [];
  const failed: string[] = [];

  // Check for spawn/agent errors
  const isSpawnError =
    output.startsWith("[squad-agent]") ||
    output.startsWith("[squad-workflow]") ||
    output.startsWith("[squad-dispatch]") ||
    output === "(no text output)" ||
    output.trim() === "";

  if (isSpawnError) {
    return {
      passed: [],
      failed: ["Agent produced no usable output"],
      blockersFailed: true,
      isError: true,
      summary: `❌ Agent error: ${output.slice(0, 200)}`,
    };
  }

  if (!taskContract) {
    return {
      passed: ["Output produced"],
      failed: [],
      blockersFailed: false,
      isError: false,
      summary: "✅ Output received (no task contract to validate against)",
    };
  }

  // Parse agent's self-validation report (## Validation Report)
  const validationMatch = output.match(
    /##\s*Validation Report[\s\S]*?((?:\s*-\s*\[(PASS|FAIL)\]\s*.+)+)/i
  );

  if (validationMatch) {
    const lines = validationMatch[1].split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const m = line.match(/\[(PASS|FAIL)\]\s*(.+)/i);
      if (m) {
        if (m[1].toUpperCase() === "PASS") {
          passed.push(m[2].trim());
        } else {
          failed.push(m[2].trim());
        }
      }
    }
  }

  // Check required outputs are mentioned in the text
  for (const out of taskContract.outputs) {
    if (!out.obrigatorio) continue;
    const mentioned = output.toLowerCase().includes(out.nome.toLowerCase());
    if (!mentioned && !passed.some((p) => p.toLowerCase().includes(out.nome.toLowerCase()))) {
      failed.push(`Required output "${out.nome}" not mentioned in agent output`);
    }
  }

  // Check blocker criteria
  let blockersFailed = false;
  for (const ac of taskContract.acceptanceCriteria) {
    if (!ac.blocker) continue;
    // If agent reported FAIL on this criterion
    const failedOnThis = failed.some((f) =>
      f.toLowerCase().includes(ac.criteria.toLowerCase().slice(0, 30))
    );
    if (failedOnThis) {
      blockersFailed = true;
    }
  }

  // Also check if there are any FAILs at all with no passes — suspicious
  if (failed.length > 0 && passed.length === 0 && !validationMatch) {
    blockersFailed = true;
  }

  const total = passed.length + failed.length;
  const summary =
    total === 0
      ? "⚠️ No validation report found in output (agent may not have self-validated)"
      : blockersFailed
        ? `❌ Validation: ${passed.length}/${total} passed — BLOCKER CRITERIA FAILED`
        : `✅ Validation: ${passed.length}/${total} passed`;

  return { passed, failed, blockersFailed, isError: false, summary };
}

// ─── Workflow Planning ───────────────────────────────────────

/**
 * Builds a task-aware workflow execution plan.
 *
 * Each step includes:
 * - Full task contract (inputs, outputs, conditions, acceptance criteria)
 * - Retry config from the task's Error Handling section
 * - Skip condition from Performance.skippable_when
 * - Dependency graph (requires/creates) for parallel execution
 */
export function buildWorkflowPlan(
  squad: ParsedSquad,
  workflowName: string
): WorkflowPlan | null {
  const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  const target = normalize(workflowName);
  const workflow = squad.workflows.find(
    (w) =>
      normalize(w.name) === target ||
      normalize(w.name).includes(target) ||
      target.includes(normalize(w.name))
  );

  if (!workflow) return null;

  const steps: WorkflowStep[] = [];

  for (const step of workflow.steps) {
    const agent = squad.agents.find(
      (a) => a.id === step.agent || a.id.endsWith(step.agent)
    );
    if (!agent) continue;

    const piName = `squad--${squad.manifest.name}--${agent.id}`;

    // Match task to agent
    const task = squad.tasks.find(
      (t) =>
        t.agent === agent.name ||
        agent.taskFiles.some((f) => t.filePath.endsWith(f))
    );

    const taskContract: TaskContract | null = task
      ? {
          name: task.name,
          inputs: task.entrada,
          outputs: task.saida,
          preConditions: task.preConditions,
          postConditions: task.postConditions,
          acceptanceCriteria: task.acceptanceCriteria,
          content: task.content,
        }
      : null;

    steps.push({
      agent: piName,
      agentId: agent.id,
      action: step.action,
      creates: step.creates,
      requires: step.requires,
      taskContract,
      retryConfig: task
        ? {
            strategy: task.errorHandling.strategy,
            maxAttempts: task.errorHandling.maxAttempts,
            delay: task.errorHandling.delay,
            fallback: task.errorHandling.fallback,
          }
        : { strategy: "abort", maxAttempts: 1, delay: "0s", fallback: "" },
      skippableWhen: task?.performance.skippableWhen || "",
    });
  }

  // Fallback: if no step has explicit requires, treat as serial chain
  const anyRequires = steps.some((s) => s.requires.length > 0);
  if (!anyRequires && steps.length > 1) {
    for (let i = 1; i < steps.length; i++) {
      if (steps[i - 1].creates) {
        steps[i].requires = [steps[i - 1].creates];
      }
    }
  }

  return {
    steps,
    name: workflow.name,
    description: workflow.description,
  };
}

/**
 * Builds a rich task prompt for a workflow step, including:
 * - Project context (initial briefing)
 * - Task assignment (action from workflow)
 * - Full task contract (inputs, outputs, conditions, acceptance criteria)
 * - Outputs from completed dependency steps
 */
export function buildTaskPrompt(
  step: WorkflowStep,
  completedArtifacts: Map<string, string>,
  initialContext: string,
  squadName: string
): string {
  const sections: string[] = [];

  // Project context
  sections.push("## Contexto do Projeto");
  sections.push(initialContext);
  sections.push("");

  // Task assignment
  sections.push("## Sua Tarefa");
  sections.push(step.action);
  sections.push("");

  // Task contract
  if (step.taskContract) {
    const tc = step.taskContract;

    if (tc.inputs.length > 0) {
      sections.push("## Inputs Disponíveis");
      for (const input of tc.inputs) {
        const req = input.obrigatorio ? "obrigatório" : "opcional";
        sections.push(`- **${input.nome}** (${input.tipo}, ${req}): ${input.descricao}`);
      }
      sections.push("");
    }

    if (tc.outputs.length > 0) {
      sections.push("## Outputs Esperados");
      sections.push("Você DEVE produzir os seguintes artefatos:");
      for (const output of tc.outputs) {
        const req = output.obrigatorio ? "🔴 OBRIGATÓRIO" : "⚪ opcional";
        sections.push(`- **${output.nome}** (${output.tipo}, ${req}): ${output.descricao}`);
      }
      sections.push("");
    }

    if (tc.preConditions.length > 0) {
      sections.push("## Pré-condições");
      sections.push("Verifique que são verdadeiras antes de começar:");
      for (const c of tc.preConditions) {
        sections.push(`- ${c}`);
      }
      sections.push("");
    }

    if (tc.postConditions.length > 0) {
      sections.push("## Pós-condições (Auto-Validar)");
      sections.push("Cada item DEVE ser verdadeiro quando finalizar:");
      for (const c of tc.postConditions) {
        sections.push(`- ${c}`);
      }
      sections.push("");
    }

    if (tc.acceptanceCriteria.length > 0) {
      sections.push("## Critérios de Aceite");
      for (const ac of tc.acceptanceCriteria) {
        const prefix = ac.blocker ? "🚫 BLOQUEANTE — deve passar" : "⚠️ DESEJÁVEL — deveria passar";
        sections.push(`- [${prefix}] ${ac.criteria}`);
      }
      sections.push("");
    }

    if (tc.content.trim()) {
      sections.push("## Detalhes da Tarefa");
      sections.push(tc.content.trim());
      sections.push("");
    }
  }

  // Context from dependency steps
  if (step.requires.length > 0) {
    const depOutputs = step.requires
      .filter((req) => completedArtifacts.has(req))
      .map((req) => ({ name: req, output: completedArtifacts.get(req)! }));

    if (depOutputs.length > 0) {
      sections.push("## Resultados dos Steps Anteriores");
      for (const dep of depOutputs) {
        sections.push(`### Artefato: ${dep.name}`);
        // Truncate very long outputs to avoid context overflow
        const maxLen = 8000;
        if (dep.output.length > maxLen) {
          sections.push(dep.output.slice(0, maxLen));
          sections.push(`\n... (truncado — ${dep.output.length} chars total)`);
        } else {
          sections.push(dep.output);
        }
        sections.push("");
      }
    }
  }

  // Output convention
  sections.push("## Convenção de Output");
  sections.push(`Salve todos os artefatos em: squads-output/${squadName}/`);
  sections.push("Nomeie os arquivos de forma descritiva baseado nos outputs esperados acima.");

  return sections.join("\n");
}
