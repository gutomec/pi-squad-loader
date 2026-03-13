/**
 * squad-parser.ts
 *
 * Parses squad.yaml manifests and agent .md files into
 * structured objects that the extension can consume.
 * Uses js-yaml for reliable deep YAML parsing.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import yaml from "js-yaml";

// ─── Types ───────────────────────────────────────────────────

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

export interface SquadTask {
  name: string;
  agent: string;
  entrada: { nome: string; tipo: string; descricao: string }[];
  saida: { nome: string; tipo: string; descricao: string }[];
  preConditions: string[];
  postConditions: string[];
  content: string;
  filePath: string;
}

export interface SquadWorkflow {
  name: string;
  description: string;
  agentSequence: string[];
  steps: { agent: string; action: string; creates: string }[];
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

  // Format 2: AIOS-style ```yaml code block (used by most squad agent files)
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

    return {
      name: safeStr(data.task) || basename(taskPath, ".md"),
      agent: safeStr(data.responsavel),
      entrada: safeArray(data.Entrada).map((e: any) => ({
        nome: safeStr(e.nome),
        tipo: safeStr(e.tipo) || "string",
        descricao: safeStr(e.descricao),
      })),
      saida: safeArray(data.Saida).map((s: any) => ({
        nome: safeStr(s.nome),
        tipo: safeStr(s.tipo) || "string",
        descricao: safeStr(s.descricao),
      })),
      preConditions: safeArray(data.Checklist?.["pre-conditions"]),
      postConditions: safeArray(data.Checklist?.["post-conditions"]),
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
    const steps = safeArray(workflow.sequence).map((s: any) => ({
      agent: safeStr(s.agent),
      action: safeStr(s.action),
      creates: safeStr(s.creates),
    }));

    return {
      name: safeStr(parsed.workflow_name) || basename(workflowPath, ".yaml"),
      description: safeStr(parsed.description),
      agentSequence: safeArray(parsed.agent_sequence),
      steps,
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
