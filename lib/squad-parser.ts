/**
 * squad-parser.ts
 *
 * Parses squad.yaml manifests, agent .md files, task .md files,
 * and workflow .yaml files into structured objects.
 *
 * Every type maps 1:1 to the schemas defined in the squads skill:
 *   - references/squad-yaml-schema.md
 *   - references/agent-schema.md
 *   - references/task-schema.md
 *   - references/workflow-schema.md
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import yaml from "js-yaml";

// ─── Types ───────────────────────────────────────────────────

export interface SquadManifestTriggers {
  enabled: boolean;
  logPath: string;
  events: { squad: boolean; agent: boolean; task: boolean };
}

export interface SquadManifest {
  name: string;
  version: string;
  description: string;
  slashPrefix: string;
  dir: string;
  components: {
    agents: string[];
    tasks: string[];
    workflows: string[];
  };
  tags: string[];
  triggers: SquadManifestTriggers;
}

export interface SquadAgent {
  id: string;
  name: string;
  title: string;
  icon: string;
  whenToUse: string;
  role: string;
  style: string;
  identity: string;
  focus: string;
  corePrinciples: string[];
  responsibilityBoundaries: string[];
  commands: SquadCommand[];
  taskFiles: string[];
  squadName: string;
  squadDir: string;
  fullContent: string;
}

export interface SquadCommand {
  name: string;
  description: string;
  args: { name: string; description: string; required: boolean }[];
}

export interface SquadTaskErrorHandling {
  strategy: "retry" | "fallback" | "abort";
  maxAttempts: number;
  delay: string;
  fallback: string;
}

export interface SquadTaskPerformance {
  duration: string;
  cost: string;
  cacheable: boolean;
  parallelizable: boolean;
  skippableWhen: string;
}

export interface SquadTask {
  name: string;
  agent: string;
  entrada: { nome: string; tipo: string; obrigatorio: boolean; descricao: string }[];
  saida: { nome: string; tipo: string; obrigatorio: boolean; descricao: string }[];
  preConditions: string[];
  postConditions: string[];
  acceptanceCriteria: { blocker: boolean; criteria: string }[];
  errorHandling: SquadTaskErrorHandling;
  performance: SquadTaskPerformance;
  content: string;
  filePath: string;
}

export interface SquadWorkflow {
  name: string;
  description: string;
  agentSequence: string[];
  steps: { agent: string; action: string; creates: string; requires: string[] }[];
  successIndicators: string[];
  filePath: string;
}

export interface ParsedSquad {
  manifest: SquadManifest;
  agents: SquadAgent[];
  tasks: SquadTask[];
  workflows: SquadWorkflow[];
}

// ─── Helpers ─────────────────────────────────────────────────

function parseYamlFrontmatter(content: string): { data: Record<string, any>; body: string } {
  // Format 1: Standard YAML frontmatter (---\n...\n---)
  const stdMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (stdMatch) {
    try {
      const data = (yaml.load(stdMatch[1]) as Record<string, any>) || {};
      return { data, body: stdMatch[2] };
    } catch {
      return { data: {}, body: stdMatch[2] || content };
    }
  }

  // Format 2: AIOS-style ```yaml code block
  const aiosMatch = content.match(/^```ya?ml\r?\n([\s\S]*?)\r?\n```\r?\n?([\s\S]*)$/);
  if (aiosMatch) {
    try {
      const data = (yaml.load(aiosMatch[1]) as Record<string, any>) || {};
      return { data, body: aiosMatch[2] };
    } catch {
      return { data: {}, body: aiosMatch[2] || content };
    }
  }

  return { data: {}, body: content };
}

function parseYamlFile(content: string): Record<string, any> {
  try {
    return (yaml.load(content) as Record<string, any>) || {};
  } catch {
    return {};
  }
}

function safeArray(val: any): any[] {
  return Array.isArray(val) ? val : [];
}

function safeStr(val: any): string {
  return typeof val === "string" ? val : String(val || "");
}

function safeBool(val: any, fallback = false): boolean {
  return typeof val === "boolean" ? val : fallback;
}

// ─── Public API ─────────────────────────────────────────────

export function discoverSquads(squadsDir: string): SquadManifest[] {
  if (!existsSync(squadsDir)) return [];

  const manifests: SquadManifest[] = [];
  const entries = readdirSync(squadsDir);

  for (const entry of entries) {
    const dir = join(squadsDir, entry);
    const yamlPath = join(dir, "squad.yaml");

    if (!existsSync(yamlPath)) continue;

    try {
      const content = readFileSync(yamlPath, "utf8");
      const parsed = parseYamlFile(content);

      const triggers = parsed.triggers || {};

      manifests.push({
        name: safeStr(parsed.name) || entry,
        version: safeStr(parsed.version) || "0.0.0",
        description: safeStr(parsed.description),
        slashPrefix: safeStr(parsed.slashPrefix) || entry.slice(0, 3),
        dir,
        components: {
          agents: safeArray(parsed.components?.agents),
          tasks: safeArray(parsed.components?.tasks),
          workflows: safeArray(parsed.components?.workflows),
        },
        tags: safeArray(parsed.tags),
        triggers: {
          enabled: safeBool(triggers.enabled),
          logPath: safeStr(triggers.logPath) || ".aios/squad-triggers/",
          events: {
            squad: safeBool(triggers.events?.squad, true),
            agent: safeBool(triggers.events?.agent, true),
            task: safeBool(triggers.events?.task, true),
          },
        },
      });
    } catch {
      // Skip unparseable squads
    }
  }

  return manifests;
}

export function parseAgent(agentPath: string, squadName: string, squadDir: string): SquadAgent | null {
  if (!existsSync(agentPath)) return null;

  try {
    const content = readFileSync(agentPath, "utf8");
    const { data, body } = parseYamlFrontmatter(content);

    const agent = data.agent || {};
    const persona = data.persona || {};
    const personaProfile = data.persona_profile || {};

    const commands: SquadCommand[] = safeArray(data.commands).map((c: any) => ({
      name: safeStr(c.name),
      description: safeStr(c.description),
      args: safeArray(c.args).map((a: any) => ({
        name: safeStr(a.name),
        description: safeStr(a.description),
        required: a.required !== false,
      })),
    }));

    return {
      id: safeStr(agent.id) || basename(agentPath, ".md"),
      name: safeStr(agent.name),
      title: safeStr(agent.title),
      icon: safeStr(agent.icon),
      whenToUse: safeStr(agent.whenToUse),
      role: safeStr(persona.role),
      style: safeStr(persona.style || personaProfile?.communication?.tone),
      identity: safeStr(persona.identity),
      focus: safeStr(persona.focus),
      corePrinciples: safeArray(persona.core_principles),
      responsibilityBoundaries: safeArray(persona.responsibility_boundaries),
      commands,
      taskFiles: safeArray(data.dependencies?.tasks),
      squadName,
      squadDir,
      fullContent: body,
    };
  } catch {
    return null;
  }
}

export function parseTask(taskPath: string): SquadTask | null {
  if (!existsSync(taskPath)) return null;

  try {
    const content = readFileSync(taskPath, "utf8");
    const { data, body } = parseYamlFrontmatter(content);

    // Parse Error Handling (key can be "Error Handling" or "ErrorHandling")
    const eh = data["Error Handling"] || data.ErrorHandling || {};
    const retryConfig = eh.retry || {};

    // Parse Performance
    const perf = data.Performance || {};

    // Parse Checklist — supports both "pre"/"post" and "pre-conditions"/"post-conditions"
    const checklist = data.Checklist || {};

    return {
      name: safeStr(data.task) || basename(taskPath, ".md"),
      agent: safeStr(data.responsavel),
      entrada: safeArray(data.Entrada).map((e: any) => ({
        nome: safeStr(e.nome || e.name),
        tipo: safeStr(e.tipo || e.type) || "string",
        obrigatorio: e.obrigatorio !== false && e.required !== false,
        descricao: safeStr(e.descricao || e.description),
      })),
      saida: safeArray(data.Saida).map((s: any) => ({
        nome: safeStr(s.nome || s.name),
        tipo: safeStr(s.tipo || s.type) || "string",
        obrigatorio: s.obrigatorio !== false && s.required !== false,
        descricao: safeStr(s.descricao || s.description),
      })),
      preConditions: safeArray(checklist["pre-conditions"] || checklist.pre),
      postConditions: safeArray(checklist["post-conditions"] || checklist.post),
      acceptanceCriteria: safeArray(checklist["acceptance-criteria"]).map((a: any) => ({
        blocker: a.blocker === true,
        criteria: safeStr(a.criteria),
      })),
      errorHandling: {
        strategy: (eh.strategy as "retry" | "fallback" | "abort") || "abort",
        maxAttempts: Number(retryConfig.max_attempts) || 1,
        delay: safeStr(retryConfig.delay) || "0s",
        fallback: safeStr(eh.fallback),
      },
      performance: {
        duration: safeStr(perf.duration_expected || perf.duration),
        cost: safeStr(perf.cost_estimated || perf.cost),
        cacheable: safeBool(perf.cacheable),
        parallelizable: safeBool(perf.parallelizable),
        skippableWhen: safeStr(perf.skippable_when || perf.skippableWhen),
      },
      content: body,
      filePath: taskPath,
    };
  } catch {
    return null;
  }
}

export function parseWorkflow(workflowPath: string): SquadWorkflow | null {
  if (!existsSync(workflowPath)) return null;

  try {
    const content = readFileSync(workflowPath, "utf8");
    const parsed = parseYamlFile(content);

    const workflow = parsed.workflow || {};
    const steps = safeArray(workflow.sequence).map((s: any) => {
      const req = s.requires;
      const requires: string[] = Array.isArray(req)
        ? req.map((r: any) => safeStr(r)).filter(Boolean)
        : req ? [safeStr(req)].filter(Boolean) : [];
      return {
        agent: safeStr(s.agent),
        action: safeStr(s.action),
        creates: safeStr(s.creates),
        requires,
      };
    });

    return {
      name: safeStr(parsed.workflow_name) || basename(workflowPath, ".yaml"),
      description: safeStr(parsed.description),
      agentSequence: safeArray(parsed.agent_sequence),
      steps,
      successIndicators: safeArray(parsed.success_indicators),
      filePath: workflowPath,
    };
  } catch {
    return null;
  }
}

export function parseFullSquad(manifest: SquadManifest): ParsedSquad {
  const agents: SquadAgent[] = [];
  const tasks: SquadTask[] = [];
  const workflows: SquadWorkflow[] = [];

  // Parse agents
  const agentsDir = join(manifest.dir, "agents");
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).filter((f) => f.endsWith(".md"))) {
      const agent = parseAgent(join(agentsDir, file), manifest.name, manifest.dir);
      if (agent) agents.push(agent);
    }
  }

  // Parse tasks
  const tasksDir = join(manifest.dir, "tasks");
  if (existsSync(tasksDir)) {
    for (const file of readdirSync(tasksDir).filter((f) => f.endsWith(".md"))) {
      const task = parseTask(join(tasksDir, file));
      if (task) tasks.push(task);
    }
  }

  // Parse workflows
  const workflowsDir = join(manifest.dir, "workflows");
  if (existsSync(workflowsDir)) {
    for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith(".yaml"))) {
      const workflow = parseWorkflow(join(workflowsDir, file));
      if (workflow) workflows.push(workflow);
    }
  }

  return { manifest, agents, tasks, workflows };
}
