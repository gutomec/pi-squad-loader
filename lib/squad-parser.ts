/**
 * squad-parser.ts — v3
 *
 * Parses squad.yaml manifests and agent/task/workflow .md files.
 * Supports v1, v2, and v3 squad formats:
 *   - v1: agent_sequence + transitions, no schemas/state/validation
 *   - v2: workflow.sequence with validation gates, state, human-gates, model_strategy
 *   - v3: harness section with doom loop, ralph loop, filesystem collaboration,
 *          traces, context compaction, self-verify, legibility
 *
 * Detection:
 *   - v1: no `state` or `harness` keys
 *   - v2: has `state` or `model_strategy` or `components.schemas` but no `harness`
 *   - v3: has `harness` key in squad.yaml
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import yaml from "js-yaml";

// ─── v3 Harness Types ───────────────────────────────────────

export interface HarnessConfig {
  doom_loop?: DoomLoopConfig;
  ralph_loop?: RalphLoopConfig;
  context_compaction?: ContextCompactionConfig;
  filesystem_collaboration?: FilesystemCollabConfig;
  traces?: TracesConfig;
  self_verify?: SelfVerifyConfig;
  middleware?: string[];
}

export interface DoomLoopConfig {
  enabled: boolean;
  max_identical_outputs?: number;      // default: 3
  similarity_threshold?: number;       // default: 0.95
  max_step_retries?: number;           // default: 5
  on_detect?: "abort" | "escalate" | "change-strategy"; // default: abort
  cooldown_seconds?: number;           // default: 0
}

export interface RalphLoopConfig {
  enabled: boolean;
  max_iterations?: number;             // default: 5
  persist_state?: boolean;             // default: true
}

export interface ContextCompactionConfig {
  enabled: boolean;
  strategy?: "truncate" | "key-fields" | "summarize"; // default: key-fields
  max_handoff_tokens?: number;         // default: 4000
  preserve_schema_fields?: boolean;    // default: true
}

export interface FilesystemCollabConfig {
  enabled: boolean;
  artifact_dir?: string;               // default: "artifacts"
  cleanup?: "on_complete" | "manual" | "never"; // default: on_complete
}

export interface TracesConfig {
  enabled: boolean;
  level?: "minimal" | "standard" | "verbose"; // default: standard
  include_outputs?: boolean;           // default: false
}

export interface SelfVerifyConfig {
  default_enabled: boolean;
}

// ─── Core Types ──────────────────────────────────────────────

export type SquadVersion = "v1" | "v2" | "v3";

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
    schemas: string[];
  };
  tags: string[];
  // Version detection
  squadVersion: SquadVersion;
  isV2: boolean;               // compat: true for v2 AND v3
  isV3: boolean;
  // v2 fields
  modelStrategy: ModelStrategy | null;
  stateConfig: StateConfig | null;
  dependencies: SquadDependencies;
  // v3 fields
  harness: HarnessConfig | null;
}

export interface ModelStrategy {
  orchestrator: string;
  workers: string;
  reviewers: string;
  override: boolean;
}

export interface StateConfig {
  enabled: boolean;
  storage: string;
  resume: boolean;
}

export interface SquadDependencies {
  node: string[];
  python: string[];
  squads: string[];
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
  // v2 fields
  model: string;
  contextBudget: number;
  contextStrategy: string;
}

export interface SquadCommand {
  name: string;
  description: string;
  args: { name: string; description: string; required: boolean }[];
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
  // v2 fields
  outputSchema: string;
  outputTemplate: string;
  assertions: string[];
}

export interface SquadTaskErrorHandling {
  strategy: string;
  maxAttempts: number;
  delay: string;
  fallback: string;
}

export interface SquadTaskPerformance {
  skippableWhen: string;
  cacheKey: string;
}

// v2/v3 workflow types
export interface V2WorkflowStep {
  type: "agent" | "human-gate";
  // agent step
  agent?: string;
  action?: string;
  model?: string;
  phase?: "planning" | "implementation" | "verification"; // v3: reasoning sandwich
  creates?: V2StepCreates | string;
  requires?: V2StepRequires[] | string;
  validation?: V2StepValidation;
  context?: V2StepContext;
  // v3: self-verify per step
  self_verify?: {
    enabled: boolean;
    checklist?: string[];
    run_tests?: string;
    max_self_fix_attempts?: number;
  };
  // v3: loop detection override per step
  loop_detection?: Partial<DoomLoopConfig>;
  // human-gate step
  id?: string;
  prompt?: string;
  questions?: V2HumanQuestion[];
}

export interface V2StepCreates {
  artifact: string;
  format: string;
  schema?: string;
  template?: string;
  inject_as?: string;
}

export interface V2StepRequires {
  artifact: string;
  inject_as: string;
}

export interface V2StepValidation {
  schema?: string;
  assertions?: string[];
  on_fail: string;
  max_retries?: number;
}

export interface V2StepContext {
  budget?: number;
  strategy?: string;
  include?: string[];
  exclude?: string[];
}

export interface V2HumanQuestion {
  id: string;
  question: string;
  options?: string[];
  type?: string;
}

export interface SquadWorkflow {
  name: string;
  description: string;
  agentSequence: string[];
  steps: { agent: string; action: string; creates: string; requires: string[] }[];
  filePath: string;
  // v2 fields
  isV2: boolean;
  v2Sequence: V2WorkflowStep[];
  v2State: { enabled: boolean; resume: boolean } | null;
  v2ModelStrategy: ModelStrategy | null;
  humanGates: string[];
  // v3 fields
  isV3: boolean;
  workflowType: "pipeline" | "dag";  // v3: dag support
  harness: HarnessConfig | null;     // v3: workflow-level harness override
}

export interface ParsedSquad {
  manifest: SquadManifest;
  agents: SquadAgent[];
  tasks: SquadTask[];
  workflows: SquadWorkflow[];
}

// ─── Helpers ─────────────────────────────────────────────────

function parseYamlFrontmatter(content: string): { data: Record<string, any>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: content };
  try {
    const data = (yaml.load(match[1]) as Record<string, any>) || {};
    return { data, body: match[2] };
  } catch {
    return { data: {}, body: match[2] || content };
  }
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

function safeNum(val: any, def: number): number {
  return typeof val === "number" ? val : def;
}

function safeBool(val: any, def: boolean): boolean {
  return typeof val === "boolean" ? val : def;
}

// ─── Version Detection ───────────────────────────────────────

export function detectSquadVersion(parsed: Record<string, any>): SquadVersion {
  // v3: has harness section
  if (parsed.harness && typeof parsed.harness === "object") return "v3";
  // v2: has state, model_strategy, or schemas
  if (parsed.state || parsed.model_strategy || (parsed.components?.schemas?.length > 0)) return "v2";
  // v1: basic
  return "v1";
}

// ─── Harness Parsing ─────────────────────────────────────────

function parseHarnessConfig(raw: any): HarnessConfig | null {
  if (!raw || typeof raw !== "object") return null;

  const config: HarnessConfig = {};

  if (raw.doom_loop) {
    config.doom_loop = {
      enabled: safeBool(raw.doom_loop.enabled, true),
      max_identical_outputs: safeNum(raw.doom_loop.max_identical_outputs, 3),
      similarity_threshold: safeNum(raw.doom_loop.similarity_threshold, 0.95),
      max_step_retries: safeNum(raw.doom_loop.max_step_retries, 5),
      on_detect: raw.doom_loop.on_detect || "abort",
      cooldown_seconds: safeNum(raw.doom_loop.cooldown_seconds, 0),
    };
  }

  if (raw.ralph_loop) {
    config.ralph_loop = {
      enabled: safeBool(raw.ralph_loop.enabled, true),
      max_iterations: safeNum(raw.ralph_loop.max_iterations, 5),
      persist_state: safeBool(raw.ralph_loop.persist_state, true),
    };
  }

  if (raw.context_compaction) {
    config.context_compaction = {
      enabled: safeBool(raw.context_compaction.enabled, true),
      strategy: raw.context_compaction.strategy || "key-fields",
      max_handoff_tokens: safeNum(raw.context_compaction.max_handoff_tokens, 4000),
      preserve_schema_fields: safeBool(raw.context_compaction.preserve_schema_fields, true),
    };
  }

  if (raw.filesystem_collaboration) {
    config.filesystem_collaboration = {
      enabled: safeBool(raw.filesystem_collaboration.enabled, true),
      artifact_dir: safeStr(raw.filesystem_collaboration.artifact_dir) || "artifacts",
      cleanup: raw.filesystem_collaboration.cleanup || "on_complete",
    };
  }

  if (raw.traces) {
    config.traces = {
      enabled: safeBool(raw.traces.enabled, true),
      level: raw.traces.level || "standard",
      include_outputs: safeBool(raw.traces.include_outputs, false),
    };
  }

  if (raw.self_verify) {
    config.self_verify = {
      default_enabled: safeBool(raw.self_verify.default_enabled, true),
    };
  }

  if (raw.middleware) {
    config.middleware = safeArray(raw.middleware);
  }

  return config;
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
      const squadVersion = detectSquadVersion(parsed);

      const ms = parsed.model_strategy;
      const st = parsed.state;

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
          schemas: safeArray(parsed.components?.schemas),
        },
        tags: safeArray(parsed.tags),
        squadVersion,
        isV2: squadVersion === "v2" || squadVersion === "v3",
        isV3: squadVersion === "v3",
        modelStrategy: ms ? {
          orchestrator: safeStr(ms.orchestrator),
          workers: safeStr(ms.workers),
          reviewers: safeStr(ms.reviewers),
          override: ms.override !== false,
        } : null,
        stateConfig: st ? {
          enabled: st.enabled !== false,
          storage: safeStr(st.storage) || "file",
          resume: st.resume !== false,
        } : null,
        dependencies: {
          node: safeArray(parsed.dependencies?.node),
          python: safeArray(parsed.dependencies?.python),
          squads: safeArray(parsed.dependencies?.squads),
        },
        harness: parseHarnessConfig(parsed.harness),
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
    const ctx = data.context || {};

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
      id: safeStr(agent.id) || safeStr(data.id) || basename(agentPath, ".md"),
      name: safeStr(agent.name) || safeStr(data.name),
      title: safeStr(agent.title) || safeStr(data.title),
      icon: safeStr(agent.icon) || safeStr(data.icon),
      whenToUse: safeStr(agent.whenToUse) || safeStr(data.whenToUse),
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
      model: safeStr(data.model || agent.model),
      contextBudget: safeNum(ctx.budget, 0),
      contextStrategy: safeStr(ctx.strategy) || "full",
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

    const checklist = data.Checklist || {};
    const errorHandling = data["Error Handling"] || data.error_handling || {};
    const performance = data.Performance || data.performance || {};
    const saida = data.Saida || {};

    return {
      name: safeStr(data.task) || basename(taskPath, ".md"),
      agent: safeStr(data.responsavel),
      entrada: safeArray(data.Entrada).map((e: any) => ({
        nome: safeStr(e.nome),
        tipo: safeStr(e.tipo) || "string",
        obrigatorio: e.obrigatorio !== false && e.required !== false,
        descricao: safeStr(e.descricao),
      })),
      saida: safeArray(data.Saida && !Array.isArray(data.Saida) ? [] : data.Saida).map((s: any) => ({
        nome: safeStr(s.nome),
        tipo: safeStr(s.tipo) || "string",
        obrigatorio: s.obrigatorio !== false && s.required !== false,
        descricao: safeStr(s.descricao),
      })),
      preConditions: safeArray(checklist["pre-conditions"]),
      postConditions: safeArray(checklist["post-conditions"]),
      acceptanceCriteria: safeArray(checklist["acceptance-criteria"]).map((a: any) => ({
        blocker: a.blocker !== false,
        criteria: safeStr(a.criteria || a),
      })),
      errorHandling: {
        strategy: safeStr(errorHandling.strategy) || "abort",
        maxAttempts: safeNum(errorHandling.max_attempts, 1),
        delay: safeStr(errorHandling.delay) || "0s",
        fallback: safeStr(errorHandling.fallback),
      },
      performance: {
        skippableWhen: safeStr(performance.skippable_when),
        cacheKey: safeStr(performance.cache_key),
      },
      content: body,
      filePath: taskPath,
      outputSchema: safeStr(saida?.schema || data.output_schema),
      outputTemplate: safeStr(saida?.template || data.output_template),
      assertions: safeArray(checklist?.verify || data.assertions),
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
    const agentSequence = safeArray(parsed.agent_sequence);
    const hasV2Sequence = Array.isArray(workflow.sequence) && workflow.sequence.length > 0;

    // v3: detect harness at workflow level
    const workflowHarness = parseHarnessConfig(workflow.harness || parsed.harness);
    const isV3 = workflowHarness !== null;
    const workflowType: "pipeline" | "dag" = (workflow.type === "dag") ? "dag" : "pipeline";

    // Build v1-compatible steps
    let steps: { agent: string; action: string; creates: string; requires: string[] }[] = [];

    if (hasV2Sequence) {
      steps = workflow.sequence
        .filter((s: any) => s.agent)
        .map((s: any) => ({
          agent: safeStr(s.agent),
          action: safeStr(s.action),
          creates: typeof s.creates === "object" ? safeStr(s.creates.artifact) : safeStr(s.creates),
          requires: typeof s.requires === "string"
            ? [s.requires]
            : safeArray(s.requires).map((r: any) => typeof r === "object" ? safeStr(r.artifact) : safeStr(r)),
        }));
    } else if (agentSequence.length > 0) {
      const keyCommands = safeArray(parsed.key_commands);
      steps = agentSequence.map((agentId: any, i: number) => ({
        agent: safeStr(agentId),
        action: keyCommands[i] ? safeStr(keyCommands[i]).replace(/^\*/, "") : safeStr(agentId),
        creates: "",
        requires: [],
      }));
    }

    // Parse v2/v3 sequence with full fidelity
    const v2Sequence: V2WorkflowStep[] = hasV2Sequence
      ? safeArray(workflow.sequence).map((s: any) => {
          if (s.type === "human-gate") {
            return {
              type: "human-gate" as const,
              id: safeStr(s.id),
              prompt: safeStr(s.prompt),
              questions: safeArray(s.questions).map((q: any) => ({
                id: safeStr(q.id),
                question: safeStr(q.question),
                options: safeArray(q.options),
                type: safeStr(q.type),
              })),
              creates: safeStr(s.creates),
            };
          }
          const step: V2WorkflowStep = {
            type: "agent" as const,
            agent: safeStr(s.agent),
            action: safeStr(s.action),
            model: safeStr(s.model),
            creates: typeof s.creates === "object" ? s.creates : safeStr(s.creates),
            requires: typeof s.requires === "string"
              ? [{ artifact: s.requires, inject_as: "full" }]
              : safeArray(s.requires).map((r: any) =>
                  typeof r === "object"
                    ? { artifact: safeStr(r.artifact), inject_as: safeStr(r.inject_as) || "full" }
                    : { artifact: safeStr(r), inject_as: "full" }
                ),
            validation: s.validation ? {
              schema: safeStr(s.validation.schema),
              assertions: safeArray(s.validation.assertions),
              on_fail: safeStr(s.validation.on_fail) || "abort",
              max_retries: safeNum(s.validation.max_retries, 1),
            } : undefined,
            context: s.context ? {
              budget: safeNum(s.context.budget, 0),
              strategy: safeStr(s.context.strategy),
              include: safeArray(s.context.include),
              exclude: safeArray(s.context.exclude),
            } : undefined,
          };

          // v3 fields
          if (s.phase) step.phase = s.phase;
          if (s.self_verify) {
            step.self_verify = {
              enabled: safeBool(s.self_verify.enabled, true),
              checklist: safeArray(s.self_verify.checklist),
              run_tests: safeStr(s.self_verify.run_tests) || undefined,
              max_self_fix_attempts: safeNum(s.self_verify.max_self_fix_attempts, 2),
            };
          }
          if (s.loop_detection) {
            step.loop_detection = {
              enabled: safeBool(s.loop_detection.enabled, true),
              max_identical_outputs: s.loop_detection.max_identical_outputs,
              on_detect: s.loop_detection.on_detect,
            };
          }

          return step;
        })
      : [];

    // Collect human gate IDs
    const humanGates = v2Sequence
      .filter((s) => s.type === "human-gate" && s.id)
      .map((s) => s.id!);

    // Model strategy from workflow level
    const wfMs = workflow.model_strategy;
    const v2ModelStrategy: ModelStrategy | null = wfMs ? {
      orchestrator: safeStr(wfMs.orchestrator),
      workers: safeStr(wfMs.workers),
      reviewers: safeStr(wfMs.reviewers),
      override: wfMs.override !== false,
    } : null;

    const v2State = workflow.state ? {
      enabled: workflow.state.enabled !== false,
      resume: workflow.state.resume !== false,
    } : null;

    return {
      name: safeStr(parsed.workflow_name) || safeStr(workflow.name) || basename(workflowPath, ".yaml"),
      description: safeStr(parsed.description) || safeStr(workflow.description) || "",
      agentSequence,
      steps,
      filePath: workflowPath,
      isV2: hasV2Sequence,
      v2Sequence,
      v2State,
      v2ModelStrategy,
      humanGates,
      isV3,
      workflowType,
      harness: workflowHarness,
    };
  } catch {
    return null;
  }
}

export function parseFullSquad(manifest: SquadManifest): ParsedSquad {
  const agents: SquadAgent[] = [];
  const tasks: SquadTask[] = [];
  const workflows: SquadWorkflow[] = [];

  const agentsDir = join(manifest.dir, "agents");
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).filter((f) => f.endsWith(".md"))) {
      const agent = parseAgent(join(agentsDir, file), manifest.name, manifest.dir);
      if (agent) agents.push(agent);
    }
  }

  const tasksDir = join(manifest.dir, "tasks");
  if (existsSync(tasksDir)) {
    for (const file of readdirSync(tasksDir).filter((f) => f.endsWith(".md"))) {
      const task = parseTask(join(tasksDir, file));
      if (task) tasks.push(task);
    }
  }

  const workflowsDir = join(manifest.dir, "workflows");
  if (existsSync(workflowsDir)) {
    for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith(".yaml"))) {
      const workflow = parseWorkflow(join(workflowsDir, file));
      if (workflow) workflows.push(workflow);
    }
  }

  return { manifest, agents, tasks, workflows };
}
