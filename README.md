<div align="center">

# pi-squad-loader

**Load specialized multi-agent Squads as native Pi SDK subagents**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.6.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![GSD-PI Extension](https://img.shields.io/badge/GSD--PI-Extension-8A2BE2)](https://github.com/nicoritschel/gsd-pi)
[![Pi SDK](https://img.shields.io/badge/Pi%20SDK-Compatible-FF6B6B)](https://github.com/nicoritschel/gsd-pi)

<br />

A [GSD-PI](https://github.com/nicoritschel/gsd-pi) extension that transforms **Squad agents** (`.md` files with YAML frontmatter) into **Pi SDK subagents** — enabling GSD-PI to dispatch tasks to domain specialists during autonomous execution.

[Installation](#installation) &bull; [Quick Start](#quick-start) &bull; [How Squads Work](#how-squads-work) &bull; [Commands & Tools](#commands--tools) &bull; [Creating a Squad](#creating-a-squad) &bull; [Troubleshooting](#troubleshooting)

</div>

---

## Why pi-squad-loader?

GSD-PI is great at autonomous code execution, but some tasks need **domain expertise** — design systems, marketing strategy, copywriting, pricing science, legal analysis, and more. Instead of building all that knowledge into a single monolithic agent, **pi-squad-loader** lets you plug in specialized multi-agent teams (Squads) that bring deep expertise to exactly the tasks that need it.

**What it does:**

- **Discovers** squads from `~/squads/` by reading `squad.yaml` manifests
- **Parses** agent `.md` files (YAML frontmatter + markdown instructions)
- **Adapts** squad agents into Pi SDK-compatible subagent format
- **Registers** tools and commands so both you and the LLM can activate and dispatch squad agents
- **Injects** squad context into the GSD pipeline for enriched autonomous execution

## Architecture

```
~/squads/                              GSD-PI Runtime
                                  ┌────────────────────────────────────┐
├── brandcraft/                   │                                    │
│   ├── squad.yaml                │   pi-squad-loader Extension        │
│   ├── agents/                   │                                    │
│   │   ├── bc-extractor.md  ────▶│   ┌──────────────┐                 │
│   │   └── bc-renderer.md  ────▶│   │ squad-parser  │  Parse YAML     │
│   ├── tasks/                    │   │    .ts        │  frontmatter    │
│   └── workflows/                │   └──────┬───────┘                 │
│                                 │          │                         │
├── sales-funnel-masters/         │   ┌──────▼───────┐                 │
│   ├── squad.yaml                │   │agent-adapter  │  Convert to     │
│   └── agents/                   │   │    .ts        │  Pi SDK format  │
│       ├── sfm-hormozi.md  ────▶│   └──────┬───────┘                 │
│       └── sfm-brunson.md  ────▶│          │                         │
│                                 │   ┌──────▼───────┐                 │
└── your-squad/                   │   │  index.ts     │  Register       │
    └── ...                       │   │  (extension)  │  tools/cmds     │
                                  │   └──────┬───────┘                 │
                                  │          │                         │
                                  │   ┌──────▼───────┐                 │
                                  │   │ Pi Subagent   │  Dispatch in    │
                                  │   │ Cache         │  isolated 200k  │
                                  │   │ ~/.gsd/agent/ │  token contexts │
                                  │   └──────────────┘                 │
                                  └────────────────────────────────────┘
```

## Installation

### Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| **Node.js** | >= 20.6.0 | `node --version` |
| **GSD-PI** | >= 0.2.x | `gsd --version` |
| **Anthropic Account** | Pro or Max | Required for OAuth login |

### Quick Install (one command)

```bash
git clone https://github.com/gutomec/pi-squad-loader.git ~/.gsd/extensions/pi-squad-loader && \
cd ~/.gsd/extensions/pi-squad-loader && npm install
```

### Step-by-Step Installation

#### 1. Install GSD-PI

If you haven't installed GSD-PI yet:

```bash
npm install -g gsd-pi
```

Verify:

```bash
gsd --version
# Expected output: GSD v0.2.x
```

#### 2. Login to GSD-PI (first time only)

```bash
gsd
# Inside the GSD interactive shell:
/login
# Select "Anthropic" as the OAuth provider
# Follow the browser login flow
```

#### 3. Clone and Install pi-squad-loader

```bash
git clone https://github.com/gutomec/pi-squad-loader.git ~/.gsd/extensions/pi-squad-loader
cd ~/.gsd/extensions/pi-squad-loader
npm install
```

#### 4. Register the Extension

Edit (or create) `~/.gsd/agent/settings.json`:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-6",
  "extensions": [
    "~/.gsd/extensions/pi-squad-loader/extensions/index.ts"
  ]
}
```

> **Note:** If the file already exists, just add the `"extensions"` array. Leave other settings untouched.

#### 5. Add Squads to ~/squads/

pi-squad-loader auto-discovers squads in `~/squads/`. Each squad must have a `squad.yaml` manifest:

```bash
mkdir -p ~/squads

# Clone any squad you want to use:
git clone https://github.com/your-org/brandcraft.git ~/squads/brandcraft
```

#### 6. Verify Installation

```bash
gsd
# Inside GSD:
/squad list
# Should display your squads with agent/task/workflow counts

/squad status
# Shows currently activated squads (none yet — that's expected)
```

If `/squad list` shows your squads, you're all set!

## Quick Start

```bash
# Start GSD-PI
gsd

# 1. See available squads
/squad list

# 2. Activate a squad (loads its agents as Pi subagents)
/squad activate brandcraft

# 3. Dispatch a specialist agent
squad_dispatch "squad--brandcraft--bc-extractor" \
  "Analyze https://example.com and extract the full design system"

# 4. Inject the output into GSD context
squad_inject "design-tokens.md" research

# 5. Continue with GSD autonomous mode — now enriched with squad output
/gsd auto
```

## How Squads Work

A **Squad** is a self-contained team of specialized AI agents, each with deep domain expertise, defined tasks, and structured workflows. Think of it as a "department" you can plug into GSD-PI.

### Squad Structure

```
~/squads/brandcraft/
├── squad.yaml              # Manifest: name, version, agents, workflows, tags
├── agents/
│   ├── bc-extractor.md     # Agent definition (YAML frontmatter + instructions)
│   ├── bc-renderer.md      # Each agent has persona, principles, capabilities
│   └── bc-strategist.md
├── tasks/
│   ├── extract-tokens.md   # Task specs with inputs, outputs, checklists
│   └── render-system.md
└── workflows/
    └── full-pipeline.yaml  # Multi-agent workflow: agent sequence + steps
```

### The Three Core Components

| Component | File Format | Purpose |
|-----------|------------|---------|
| **Agents** | `.md` with YAML frontmatter | Define persona, role, principles, capabilities, and system prompt |
| **Tasks** | `.md` with YAML frontmatter | Specify inputs, outputs, pre/post conditions for agent work |
| **Workflows** | `.yaml` | Define sequential agent chains where each step feeds the next |

### How Loading Works

When you run `/squad activate {name}`, pi-squad-loader:

1. **Reads** the `squad.yaml` manifest to discover agents, tasks, and workflows
2. **Parses** each agent's `.md` file, extracting YAML frontmatter (persona, role, principles, commands) and the markdown body (detailed instructions)
3. **Infers** appropriate Pi SDK tools for each agent based on their role (e.g., research agents get `web_search`, design agents get `browser`)
4. **Selects** the optimal model (orchestrators/strategists get `claude-opus-4-6`, implementation agents get `claude-sonnet-4-6`)
5. **Writes** Pi-compatible `.md` agent files to `~/.gsd/agent/agents/`
6. **Registers** the agents so they can be dispatched via the `subagent` tool

### Agent Naming Convention

Activated agents follow this naming pattern:

```
squad--{squad-name}--{agent-id}
```

Examples:
- `squad--brandcraft--bc-extractor`
- `squad--sales-funnel-masters--sfm-hormozi`
- `squad--gsd-bridge--gsb-collector`

## Commands & Tools

### Slash Commands (Interactive)

Use these inside the GSD interactive shell:

| Command | Description |
|---------|-------------|
| `/squad list [filter]` | Discover all available squads, optionally filtered by name |
| `/squad agents {name}` | List all agents in a squad with their capabilities |
| `/squad activate {name}` | Load a squad's agents as Pi subagents |
| `/squad run {squad} {workflow}` | Run a complete multi-agent workflow (opens briefing editor) |
| `/squad inject {path} [type]` | Inject an artifact into GSD context |
| `/squad status` | Show currently activated squads and agents |

### LLM-Callable Tools

These tools are registered so the LLM can call them autonomously during GSD execution:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `squad_list` | `filter?` | List squads, filterable by name, tag, or description |
| `squad_activate` | `name` | Activate a squad, loading all its agents |
| `squad_dispatch` | `agent`, `task`, `context?` | Dispatch a task to a specific squad agent |
| `squad_workflow` | `squad`, `workflow`, `context` | Run a full workflow as a sequential agent chain |
| `squad_inject` | `artifactPath`, `targetType`, `label?` | Inject artifact into GSD project context |
| `squad_status` | *(none)* | Check which squads and agents are currently active |

### Artifact Injection Targets

When injecting squad output into the GSD pipeline, choose the appropriate target:

| Target Type | Location | When to Use |
|-------------|----------|-------------|
| `research` | `.gsd/milestones/M001/research/` | Feed into GSD planning phase |
| `decision` | `.gsd/DECISIONS.md` (appended) | Record strategic decisions |
| `context` | `.gsd/squad-context/` | Inject into next agent's system prompt |

## Usage Examples

### Example 1: Landing Page with Design + Marketing Squads

```bash
# Activate both squads
/squad activate brandcraft
/squad activate sales-funnel-masters

# Extract design system from a reference site
squad_dispatch "squad--brandcraft--bc-extractor" \
  "Analyze https://stripe.com and extract design tokens: colors, typography, spacing, components"

# Generate a high-converting offer strategy
squad_dispatch "squad--sales-funnel-masters--sfm-hormozi" \
  "Create a Grand Slam Offer for a SaaS developer tool priced at $29/mo"

# Inject both artifacts into GSD context
squad_inject "design-tokens.md" research
squad_inject "offer-stack.md" research

# Let GSD build the landing page with enriched context
/gsd auto
```

### Example 2: Running a Full Squad Workflow

```bash
# Activate the squad
/squad activate brandcraft

# Run the full brand extraction pipeline
# (each agent receives the previous agent's output)
/squad run brandcraft full-pipeline
# → Opens briefing editor where you provide initial context
# → Agents execute sequentially: extractor → strategist → renderer
```

### Example 3: Programmatic Dispatch with Context Chaining

```bash
# First agent extracts raw data
squad_dispatch "squad--brandcraft--bc-extractor" \
  "Extract design tokens from https://linear.app"

# Second agent receives the first agent's output as context
squad_dispatch "squad--brandcraft--bc-renderer" \
  "Generate a complete Tailwind theme" \
  --context "$(cat design-tokens.md)"
```

## Creating a Squad

Want to create your own squad? Here's a complete guide.

### 1. Create the Directory Structure

```bash
mkdir -p ~/squads/my-squad/{agents,tasks,workflows}
```

### 2. Write the Manifest (`squad.yaml`)

```yaml
name: "my-squad"
version: "1.0.0"
description: "A specialized squad for [your domain]"
author: "your-name"
license: MIT
slashPrefix: "ms"

aios:
  minVersion: "2.1.0"
  type: squad

components:
  agents:
    - "ms-analyst.md"
    - "ms-executor.md"
  tasks:
    - "ms-analyst-research.md"
    - "ms-executor-implement.md"
  workflows:
    - "main-pipeline.yaml"

tags:
  - "your-domain"
  - "analysis"
```

### 3. Define an Agent (`agents/ms-analyst.md`)

Agents are Markdown files with YAML frontmatter that defines their persona:

```markdown
---
agent:
  id: ms-analyst
  name: "MS Analyst"
  title: "Domain Analyst"
  icon: "🔍"
  whenToUse: "When deep domain analysis is needed before implementation"

persona:
  role: "Senior Domain Analyst"
  style: "Methodical, data-driven, thorough"
  identity: "Expert analyst who uncovers patterns and actionable insights"
  focus: "Deep research and structured analysis"
  core_principles:
    - "Evidence over assumptions — always cite sources"
    - "Structure over freeform — use frameworks"
    - "Actionable over theoretical — every insight leads to action"
  responsibility_boundaries:
    - "DO: Research, analyze, recommend"
    - "DO NOT: Implement, code, or make final decisions"

commands:
  - name: research
    description: "Conduct deep research on a topic"
    args:
      - name: topic
        description: "The subject to research"
        required: true

dependencies:
  tasks:
    - "ms-analyst-research.md"
---

## Collaboration Patterns

When working with other agents in this squad:
- Share structured findings using consistent markdown format
- Flag uncertainties explicitly with confidence levels
- Provide clear handoff notes for the executor agent
```

### 4. Define a Task (`tasks/ms-analyst-research.md`)

```markdown
---
task: "ms-analyst-research"
responsavel: "MS Analyst"

Entrada:
  - nome: topic
    tipo: string
    descricao: "The subject to research and analyze"
  - nome: depth
    tipo: string
    descricao: "Analysis depth: surface | standard | deep"

Saida:
  - nome: analysis_report
    tipo: markdown
    descricao: "Structured analysis report with findings and recommendations"

Checklist:
  pre-conditions:
    - "Topic is clearly defined"
    - "Scope boundaries are set"
  post-conditions:
    - "Report includes at least 3 key findings"
    - "Each finding has supporting evidence"
    - "Actionable recommendations are provided"
---

## Task Instructions

Conduct a thorough analysis following this structure:

1. **Context Setting** — Frame the problem space
2. **Data Gathering** — Collect relevant information
3. **Pattern Analysis** — Identify trends and patterns
4. **Findings** — Present key discoveries with evidence
5. **Recommendations** — Actionable next steps
```

### 5. Define a Workflow (`workflows/main-pipeline.yaml`)

```yaml
workflow_name: "main-pipeline"
description: "Full analysis-to-implementation pipeline"

agent_sequence:
  - ms-analyst
  - ms-executor

workflow:
  sequence:
    - agent: ms-analyst
      action: research
      creates: "analysis-report.md"
    - agent: ms-executor
      action: implement
      creates: "implementation-output"
```

### 6. Test Your Squad

```bash
gsd

/squad list
# → Should show "my-squad" with 2 agents, 2 tasks, 1 workflow

/squad agents my-squad
# → Shows agent details and capabilities

/squad activate my-squad
# → Loads agents as Pi subagents

# Dispatch a task
squad_dispatch "squad--my-squad--ms-analyst" \
  "Research the best practices for API rate limiting in SaaS applications"
```

### Agent Frontmatter Formats

pi-squad-loader supports two frontmatter schemas:

**Nested format** (recommended for full squads):
```yaml
agent:
  id: my-agent
  name: "My Agent"
  title: "Agent Title"
persona:
  role: "..."
  core_principles: [...]
```

**Flat format** (simpler, for standalone agents):
```yaml
id: my-agent
name: "My Agent"
role: "..."
core_principles: [...]
```

## Components

| File | Purpose |
|------|---------|
| [`extensions/index.ts`](extensions/index.ts) | Extension entry point — registers 6 tools, 1 command, and 2 event hooks |
| [`lib/squad-parser.ts`](lib/squad-parser.ts) | Parses `squad.yaml` manifests and agent/task/workflow `.md` files using `js-yaml` |
| [`lib/agent-adapter.ts`](lib/agent-adapter.ts) | Converts squad agents to Pi SDK format, infers tools and model selection |
| [`skills/squad-loader/SKILL.md`](skills/squad-loader/SKILL.md) | Skill definition for LLM discovery and prompt guidance |

### Key Dependencies

| Package | Purpose |
|---------|---------|
| `js-yaml` | Reliable YAML parsing for squad manifests and frontmatter |
| `gray-matter` | Markdown frontmatter extraction |
| `@sinclair/typebox` | Runtime type schema for tool parameters |

## Troubleshooting

### `/squad list` shows no squads

**Cause:** The `~/squads/` directory is missing or has no valid squad directories.

```bash
# Check the directory exists
ls ~/squads/

# Verify squad manifests exist
ls ~/squads/*/squad.yaml

# If empty, clone a squad:
git clone https://github.com/your-org/your-squad.git ~/squads/your-squad
```

### Extension not loading in GSD

**Cause:** The extension path in `settings.json` is incorrect or dependencies are missing.

```bash
# Verify the path exists
ls ~/.gsd/extensions/pi-squad-loader/extensions/index.ts

# Reinstall dependencies
cd ~/.gsd/extensions/pi-squad-loader && npm install

# Check settings.json has the correct path
cat ~/.gsd/agent/settings.json
```

> **Important:** Restart GSD after any changes to `settings.json`.

### Agent dispatch fails with "not found"

**Cause:** The squad hasn't been activated yet.

```bash
# Inside GSD:
/squad activate {squad-name}

# Then retry the dispatch
squad_dispatch "squad--{squad-name}--{agent-id}" "your task"
```

### Login / authentication issues

GSD-PI uses **OAuth authentication** (not API keys). You need an Anthropic Pro or Max subscription.

```bash
gsd
/login
# Select "Anthropic" → Follow the browser flow
```

### Agents are activated but LLM doesn't use them

**Check:** The `before_agent_start` hook automatically injects squad context into the LLM's system prompt. If agents aren't being dispatched:

1. Verify the squad is activated: `/squad status`
2. Be explicit in your prompt: *"Use the brandcraft extractor agent to analyze this site"*
3. Check that agent files exist in `~/.gsd/agent/agents/`:
   ```bash
   ls ~/.gsd/agent/agents/squad--*
   ```

### Local development mode

If you cloned the repo outside `~/.gsd/extensions/`, point `settings.json` to its absolute path:

```json
{
  "extensions": [
    "/absolute/path/to/pi-squad-loader/extensions/index.ts"
  ]
}
```

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

[MIT](https://opensource.org/licenses/MIT) -- see [LICENSE](LICENSE) for details.

---

<div align="center">

**Built for the [GSD-PI](https://github.com/nicoritschel/gsd-pi) ecosystem**

</div>
