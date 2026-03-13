/**
 * agent-adapter.ts
 *
 * Converts squad agent definitions (.md with YAML frontmatter)
 * into Pi SDK agent format (.md with Pi-compatible frontmatter).
 *
 * Pi agents expect:
 * ---
 * name: agent-name
 * description: what it does
 * tools: read, grep, bash, ...
 * model: claude-sonnet-4-6  (optional)
 * ---
 * System prompt content...
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { SquadAgent, SquadTask, ParsedSquad } from "./squad-parser.js";

// ─── Types ───────────────────────────────────────────────────

export interface PiAgentFile {
  /** File path where the adapted agent will be written */
  path: string;
  /** Agent name for Pi SDK (squad-prefix--agent-id) */
  piName: string;
  /** Original squad agent */
  source: SquadAgent;
  /** Generated markdown content */
  content: string;
}

// ─── Tool mapping ────────────────────────────────────────────

/**
 * Maps squad agent roles to appropriate Pi SDK tools.
 * Squad agents don't specify tools — we infer from their responsibilities.
 */
function inferTools(agent: SquadAgent): string[] {
  const base = ["read", "grep", "bash", "write", "edit"];
  const role = `${agent.role} ${agent.focus} ${agent.identity}`.toLowerCase();

  // Agents that need web access
  if (
    role.includes("research") ||
    role.includes("analysis") ||
    role.includes("market") ||
    role.includes("competitor") ||
    role.includes("web")
  ) {
    base.push("web_search");
  }

  // Agents that produce visual outputs
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

/**
 * Determines the best model for an agent based on its complexity.
 * Orchestrators and strategy agents → opus (deep reasoning)
 * Implementation agents → sonnet (fast, capable)
 */
function inferModel(agent: SquadAgent): string | undefined {
  const id = agent.id.toLowerCase();
  const role = agent.role.toLowerCase();

  // Orchestrators need strong reasoning
  if (id.includes("orchestrator") || role.includes("coordinat") || role.includes("orchestrat")) {
    return "claude-opus-4-6";
  }

  // Strategy/architecture agents benefit from opus
  if (
    role.includes("architect") ||
    role.includes("strateg") ||
    role.includes("analys")
  ) {
    return "claude-opus-4-6";
  }

  // Implementation/execution agents work well with sonnet
  return "claude-sonnet-4-6";
}

// ─── Adapter ─────────────────────────────────────────────────

/**
 * Converts a squad agent into a Pi-compatible agent markdown file.
 */
export function adaptAgent(agent: SquadAgent, tasks: SquadTask[]): PiAgentFile {
  const piName = `squad--${agent.squadName}--${agent.id}`;
  const tools = inferTools(agent);
  const model = inferModel(agent);

  // Find tasks belonging to this agent
  const agentTasks = tasks.filter(
    (t) =>
      t.agent === agent.name ||
      agent.taskFiles.some((f) => t.filePath.endsWith(f))
  );

  // Build system prompt
  const systemPrompt = buildSystemPrompt(agent, agentTasks);

  // Build Pi-compatible frontmatter
  const frontmatter = [
    "---",
    `name: ${piName}`,
    `description: "${agent.icon} ${agent.title} — ${agent.whenToUse}"`,
    `tools: ${tools.join(", ")}`,
  ];

  if (model) {
    frontmatter.push(`model: ${model}`);
  }

  frontmatter.push("---");

  const content = frontmatter.join("\n") + "\n\n" + systemPrompt;

  return {
    path: "", // Set by caller based on output directory
    piName,
    source: agent,
    content,
  };
}

/**
 * Builds the system prompt for a Pi subagent from squad agent data.
 *
 * The prompt must give the agent a clear identity, operational instructions,
 * and enough context to execute the task it receives. The task itself comes
 * from the dispatch call — the system prompt sets up WHO the agent is and
 * HOW it should work, not WHAT specific task to do.
 */
function buildSystemPrompt(agent: SquadAgent, tasks: SquadTask[]): string {
  const sections: string[] = [];

  // ── Identity ──────────────────────────────────────────
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

  // ── Focus Area ────────────────────────────────────────
  if (agent.focus) {
    sections.push("## Focus");
    sections.push(agent.focus);
    sections.push("");
  }

  // ── Core Principles ───────────────────────────────────
  if (agent.corePrinciples.length > 0) {
    sections.push("## Principles (Non-Negotiable)");
    for (const p of agent.corePrinciples) {
      sections.push(`- ${p}`);
    }
    sections.push("");
  }

  // ── Boundaries ────────────────────────────────────────
  if (agent.responsibilityBoundaries.length > 0) {
    sections.push("## Responsibility Boundaries");
    for (const b of agent.responsibilityBoundaries) {
      sections.push(`- ${b}`);
    }
    sections.push("");
  }

  // ── Operational Instructions ──────────────────────────
  sections.push("## How to Execute");
  sections.push("");
  sections.push("When you receive a task:");
  sections.push("1. Read the referenced files and paths from the task description");
  sections.push("2. Use your tools (read, bash, grep, write, edit) to analyze the codebase");
  sections.push("3. Produce your findings as structured markdown");
  sections.push("4. Be specific: include file paths, line numbers, code evidence, and severity");
  sections.push("5. End with clear, actionable recommendations");
  sections.push("");

  // ── Task Knowledge ────────────────────────────────────
  // Only include task specs that belong to this agent
  if (tasks.length > 0) {
    sections.push("## Task Specifications");
    sections.push("");
    for (const task of tasks) {
      sections.push(`### ${task.name}`);
      if (task.saida.length > 0) {
        sections.push("**Expected outputs:**");
        for (const s of task.saida) {
          sections.push(`- \`${s.nome}\` (${s.tipo}): ${s.descricao}`);
        }
      }
      if (task.postConditions.length > 0) {
        sections.push("**Success criteria:**");
        for (const c of task.postConditions) {
          sections.push(`- ${c}`);
        }
      }
      if (task.content.trim()) {
        sections.push("");
        sections.push(task.content.trim());
      }
      sections.push("");
    }
  }

  // ── Additional Context from agent body ────────────────
  // Only include if it has substantive content (not just YAML repasted)
  if (agent.fullContent.trim()) {
    const body = agent.fullContent.trim();
    // Skip if body is just a YAML dump or too short to be useful
    if (body.length > 50 && !body.startsWith("agent:") && !body.startsWith("persona:")) {
      sections.push("## Additional Context");
      sections.push("");
      sections.push(body);
      sections.push("");
    }
  }

  // ── Output Format ─────────────────────────────────────
  sections.push("## Output Format");
  sections.push("");
  sections.push("Return your results as structured markdown:");
  sections.push("1. **Summary** — what was analyzed and key findings count");
  sections.push("2. **Findings** — each with severity, location (file:line), evidence, and fix");
  sections.push("3. **Recommendations** — prioritized actionable next steps");

  return sections.join("\n");
}

/**
 * Adapts all agents from a parsed squad and writes them to the agents cache directory.
 */
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

/**
 * Generates a workflow dispatch plan from a squad workflow.
 * Returns a chain specification for the Pi subagent extension.
 */
export function buildWorkflowChain(
  squad: ParsedSquad,
  workflowName: string
): { agent: string; task: string }[] | null {
  // Normalize for matching: replace - with _ and vice versa, case-insensitive
  const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  const target = normalize(workflowName);
  const workflow = squad.workflows.find(
    (w) => normalize(w.name) === target || normalize(w.name).includes(target) || target.includes(normalize(w.name))
  );

  if (!workflow) return null;

  const chain: { agent: string; task: string }[] = [];

  for (const step of workflow.steps) {
    // Find the matching agent
    const agent = squad.agents.find(
      (a) => a.id === step.agent || a.id.endsWith(step.agent)
    );

    if (!agent) continue;

    const piName = `squad--${squad.manifest.name}--${agent.id}`;

    // Build task description from the step action
    const matchingTask = squad.tasks.find((t) =>
      t.name.toLowerCase().includes(step.action.replace(/-/g, ""))
    );

    let taskDescription = `Execute: ${step.action}`;
    if (matchingTask) {
      taskDescription = `${matchingTask.content.trim().slice(0, 500)}`;
    }

    if (chain.length > 0) {
      taskDescription = `Based on previous output:\n{previous}\n\n${taskDescription}`;
    }

    if (step.creates) {
      taskDescription += `\n\nExpected output artifact: ${step.creates}`;
    }

    chain.push({ agent: piName, task: taskDescription });
  }

  return chain;
}
