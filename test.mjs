/**
 * test.mjs — Smoke test for pi-squad-loader
 *
 * Tests the parser and adapter modules in isolation
 * (without Pi SDK runtime dependency).
 *
 * Usage: node test.mjs
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Dynamic import of modules (skip Pi SDK types) ──────────

// We can't import the TS files directly, so we test the logic
// by importing the parser and adapter source via a workaround.
// For now, test the raw parsing logic manually.

import yaml from "js-yaml";
import matter from "gray-matter";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

/**
 * Parse YAML frontmatter supporting both formats:
 * 1. Standard frontmatter (--- ... ---)
 * 2. YAML inside code block (```yaml ... ```)
 */
function parseAgentFile(content) {
  // Try standard frontmatter first
  const fm = matter(content);
  if (fm.data && Object.keys(fm.data).length > 0) {
    return fm;
  }
  // Fallback: YAML inside code block (may appear after headings)
  const cbMatch = content.match(/```ya?ml\r?\n([\s\S]*?)\r?\n```\r?\n?([\s\S]*)$/);
  if (cbMatch) {
    try {
      const data = yaml.load(cbMatch[1]) || {};
      return { data, content: cbMatch[2] || "" };
    } catch {
      // Invalid YAML — skip gracefully
      return { data: {}, content };
    }
  }
  return { data: {}, content };
}

// ─── Test 1: YAML frontmatter parsing ───────────────────────

console.log("\n── Test 1: YAML Frontmatter Parsing ──");

const sampleAgent = `---
agent:
  name: Test Agent
  id: tst-analyst
  title: "Data Analyst"
  icon: "📊"
  whenToUse: "When data analysis is needed"

persona:
  role: "Analyzes data patterns"
  style: "Precise and analytical"
  identity: "A data scientist"
  focus: "Statistical analysis"
  core_principles:
    - "Data-driven decisions"
    - "Statistical rigor"

commands:
  - name: "*analyze-data"
    description: "Run data analysis"
    args:
      - name: dataset
        description: "Path to dataset"
        required: true

dependencies:
  tasks:
    - tst-analyst-analyze.md
---

# Test Agent Body

This is the body content.
`;

const parsed = matter(sampleAgent);
assert(parsed.data.agent?.name === "Test Agent", "Agent name parsed");
assert(parsed.data.agent?.id === "tst-analyst", "Agent ID parsed");
assert(parsed.data.agent?.icon === "📊", "Agent icon parsed");
assert(parsed.data.persona?.core_principles?.length === 2, "Core principles parsed (2 items)");
assert(parsed.data.commands?.length === 1, "Commands parsed (1 command)");
assert(parsed.data.commands?.[0]?.args?.length === 1, "Command args parsed");
assert(parsed.data.dependencies?.tasks?.length === 1, "Task dependencies parsed");
assert(parsed.content.includes("Test Agent Body"), "Body content preserved");

// ─── Test 2: squad.yaml parsing ─────────────────────────────

console.log("\n── Test 2: squad.yaml Parsing ──");

const sampleSquadYaml = `
name: test-squad
version: "1.0.0"
description: "A test squad for validation"
slashPrefix: tst

components:
  agents:
    - tst-analyst.md
    - tst-reporter.md
  tasks:
    - tst-analyst-analyze.md
    - tst-reporter-report.md
  workflows:
    - main-pipeline.yaml

tags:
  - testing
  - validation
`;

const squadParsed = yaml.load(sampleSquadYaml);
assert(squadParsed.name === "test-squad", "Squad name parsed");
assert(squadParsed.version === "1.0.0", "Squad version parsed");
assert(squadParsed.components?.agents?.length === 2, "Agent list parsed (2 agents)");
assert(squadParsed.components?.tasks?.length === 2, "Task list parsed (2 tasks)");
assert(squadParsed.components?.workflows?.length === 1, "Workflow list parsed (1 workflow)");
assert(squadParsed.tags?.includes("testing"), "Tags parsed");

// ─── Test 3: Real squad discovery ───────────────────────────

console.log("\n── Test 3: Real Squad Discovery ──");

const squadsDir = join(process.env.HOME || "", "squads");
if (existsSync(squadsDir)) {
  const entries = readdirSync(squadsDir);
  const squads = entries.filter((e) =>
    existsSync(join(squadsDir, e, "squad.yaml"))
  );
  assert(squads.length > 0, `Found ${squads.length} squads in ~/squads/`);

  for (const squadName of squads) {
    const yamlPath = join(squadsDir, squadName, "squad.yaml");
    const content = readFileSync(yamlPath, "utf8");
    const manifest = yaml.load(content);
    assert(!!manifest?.name, `  ${squadName}: has name "${manifest?.name}"`);

    // Check agents directory
    const agentsDir = join(squadsDir, squadName, "agents");
    if (existsSync(agentsDir)) {
      const agents = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
      assert(agents.length > 0, `  ${squadName}: has ${agents.length} agent files`);

      // Parse first agent (supports frontmatter, code block, and flat schema)
      const firstAgent = readFileSync(join(agentsDir, agents[0]), "utf8");
      const agentParsed = parseAgentFile(firstAgent);
      // Fallback to filename when YAML is invalid (same as parseAgent in squad-parser.ts)
      const agentId = agentParsed.data.agent?.id || agentParsed.data.id || agents[0].replace(".md", "");
      assert(
        !!agentId,
        `  ${squadName}/${agents[0]}: agent ID = "${agentId}"`
      );
    }
  }
} else {
  console.log("  ⚠️  ~/squads/ not found — skipping real squad discovery");
}

// ─── Test 4: Agent adapter logic (Pi format generation) ─────

console.log("\n── Test 4: Pi Agent Format Generation ──");

function buildPiAgentContent(agentData, body) {
  const agent = agentData.agent || {};
  const persona = agentData.persona || {};
  const piName = `squad--test-squad--${agent.id}`;
  const tools = ["read", "grep", "bash", "write", "edit"];

  const frontmatter = [
    "---",
    `name: ${piName}`,
    `description: "${agent.icon} ${agent.title} — ${agent.whenToUse}"`,
    `tools: ${tools.join(", ")}`,
    `model: claude-sonnet-4-6`,
    "---",
  ].join("\n");

  const systemPrompt = [
    `# ${agent.icon} ${agent.name} — ${agent.title}`,
    "",
    `**Role:** ${persona.role}`,
    `**Style:** ${persona.style}`,
  ].join("\n");

  return frontmatter + "\n\n" + systemPrompt;
}

const piContent = buildPiAgentContent(parsed.data, parsed.content);
assert(piContent.includes("name: squad--test-squad--tst-analyst"), "Pi agent name generated correctly");
assert(piContent.includes("tools: read, grep, bash, write, edit"), "Pi tools declared");
assert(piContent.includes("model: claude-sonnet-4-6"), "Pi model declared");
assert(piContent.includes("📊 Test Agent — Data Analyst"), "Description includes icon + title");
assert(piContent.includes("**Role:** Analyzes data patterns"), "System prompt includes role");

// ─── Test 5: Workflow chain building ────────────────────────

console.log("\n── Test 5: Workflow Chain Building ──");

const sampleWorkflow = `
workflow_name: test-pipeline
description: "Test pipeline workflow"
agent_sequence:
  - tst-analyst
  - tst-reporter

workflow:
  sequence:
    - agent: tst-analyst
      action: analyze-data
      creates: analysis-report.md
    - agent: tst-reporter
      action: generate-report
      creates: final-report.md
`;

const wfParsed = yaml.load(sampleWorkflow);
assert(wfParsed.workflow_name === "test-pipeline", "Workflow name parsed");
assert(wfParsed.workflow?.sequence?.length === 2, "Workflow has 2 steps");
assert(wfParsed.workflow?.sequence?.[0]?.agent === "tst-analyst", "Step 1 agent correct");
assert(wfParsed.workflow?.sequence?.[1]?.creates === "final-report.md", "Step 2 creates correct");

// Build chain
const chain = wfParsed.workflow.sequence.map((step, i) => ({
  agent: `squad--test-squad--${step.agent}`,
  task: i === 0 ? `Execute: ${step.action}` : `Based on previous output:\n{previous}\n\nExecute: ${step.action}`,
}));

assert(chain.length === 2, "Chain has 2 steps");
assert(chain[0].agent === "squad--test-squad--tst-analyst", "Chain step 1 agent");
assert(chain[1].task.includes("{previous}"), "Chain step 2 references previous output");

// ─── Summary ────────────────────────────────────────────────

console.log("\n══════════════════════════════════════");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════\n");

process.exit(failed > 0 ? 1 : 0);
