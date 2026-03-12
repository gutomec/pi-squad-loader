# pi-squad-loader

> GSD-PI extension that loads the Squads ecosystem as native Pi SDK subagents.

## What it does

Transforms squad agents (`.md` with YAML frontmatter) into Pi SDK subagents, enabling GSD-PI to dispatch tasks to domain specialists (design, marketing, copy, pricing, etc.) during autonomous execution.

## Architecture

```
~/squads/                         GSD-PI Runtime
├── brandcraft/                   ┌─────────────────────────┐
│   ├── squad.yaml                │                         │
│   └── agents/*.md    ──────────▶│  pi-squad-loader        │
├── sales-funnel-masters/         │    ├── squad-parser.ts   │
│   ├── squad.yaml                │    ├── agent-adapter.ts  │
│   └── agents/*.md    ──────────▶│    └── index.ts         │
└── ...                           │                         │
                                  │  Adapted agents (.md)   │
                                  │    → Pi subagent cache   │
                                  │                         │
                                  │  Dispatch in isolated    │
                                  │  200k token contexts     │
                                  └─────────────────────────┘
```

## Prerequisites

- **Node.js** >= 20.6.0
- **GSD-PI** installed globally (`npm install -g gsd-pi`)
- **Anthropic account** with Pro/Max subscription (for OAuth login)

## Installation

### Quick install (one command)

```bash
git clone https://github.com/gutomec/pi-squad-loader.git ~/.gsd/extensions/pi-squad-loader && \
cd ~/.gsd/extensions/pi-squad-loader && npm install
```

### Step by step

#### 1. Install GSD-PI (if you haven't)

```bash
npm install -g gsd-pi
```

Verify:

```bash
gsd --version
# → GSD v0.2.x
```

#### 2. Login to GSD-PI (first time only)

```bash
gsd
# Inside the GSD interactive shell:
/login
# Select "Anthropic" OAuth provider
# Follow the browser login flow
```

#### 3. Clone and install Squad Loader

```bash
git clone https://github.com/gutomec/pi-squad-loader.git ~/.gsd/extensions/pi-squad-loader
cd ~/.gsd/extensions/pi-squad-loader
npm install
```

#### 4. Register the extension

Edit (or create) `~/.gsd/agent/settings.json`:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-6",
  "extensions": ["~/.gsd/extensions/pi-squad-loader/extensions/index.ts"]
}
```

If the file already exists, just add the `"extensions"` field.

#### 5. Add squads to ~/squads/

The Squad Loader discovers squads in `~/squads/`. Each squad needs a `squad.yaml` manifest.

```bash
mkdir -p ~/squads

# Clone any squad you want to use:
git clone https://github.com/your-org/your-squad.git ~/squads/your-squad
```

Squad structure:

```
~/squads/your-squad/
├── squad.yaml          # Manifest (name, description, agents, workflows)
├── agents/
│   ├── agent-one.md    # Agent definition (YAML frontmatter + instructions)
│   └── agent-two.md
├── tasks/
│   └── task-one.md
└── workflows/
    └── main.yaml
```

#### 6. Verify installation

```bash
gsd
# Inside GSD:
/squad list       # → Should show your squads
/squad status     # → Shows active squads and agents
```

### Alternative: Local development mode

If you cloned the repo elsewhere, point settings.json to it:

```json
{
  "extensions": ["/absolute/path/to/pi-squad-loader/extensions/index.ts"]
}
```

## Usage

### Commands

| Command | Purpose |
|---------|---------|
| `/squad list` | Discover all available squads in ~/squads/ |
| `/squad agents {name}` | See agents and their capabilities |
| `/squad activate {name}` | Load squad agents as Pi subagents |
| `/squad run {name} {workflow}` | Run a complete multi-agent workflow |
| `/squad inject {path}` | Feed artifact into .gsd/ context |
| `/squad status` | Show currently active squads |

### Tools (LLM-callable)

| Tool | Purpose |
|------|---------|
| `squad_list` | List squads (filterable by name/tag) |
| `squad_activate` | Activate a squad's agents |
| `squad_dispatch` | Send task to a specific squad agent |
| `squad_workflow` | Run workflow as sequential agent chain |
| `squad_inject` | Inject artifact into GSD context |
| `squad_status` | Check activation status |

### Typical Flow

```
1. /squad list                    → See what's available
2. /squad activate brandcraft     → Load agents
3. squad_dispatch agent task      → Get specialist output
4. squad_inject artifact research → Feed into GSD context
5. /gsd auto                      → GSD uses the enriched context
```

### Example: Building a Landing Page

```bash
# 1. Activate design + marketing squads
/squad activate brandcraft
/squad activate sales-funnel-masters

# 2. Extract design system
squad_dispatch "squad--brandcraft--bc-extractor" \
  "Analyze https://example.com and extract design tokens"

# 3. Get offer strategy
squad_dispatch "squad--sales-funnel-masters--sfm-hormozi" \
  "Create Grand Slam Offer for SaaS targeting developers"

# 4. Inject artifacts into GSD context
squad_inject "design-tokens.md" research
squad_inject "offer-stack.md" research

# 5. GSD auto picks up enriched context
/gsd auto
```

### Artifact Injection Targets

Squad artifacts can be injected into three places:

| Type | Target | Used by |
|------|--------|---------|
| `research` | `.gsd/milestones/M001/research/` | GSD planning phase |
| `decision` | `.gsd/DECISIONS.md` (append) | Decision log |
| `context` | `.gsd/squad-context/` | Next agent's system prompt |

## Agent Naming Convention

Activated agents follow the pattern: `squad--{squad-name}--{agent-id}`

Examples:
- `squad--brandcraft--bc-extractor`
- `squad--sales-funnel-masters--sfm-hormozi`
- `squad--gsd-bridge--gsb-collector`

## Components

| File | Function |
|------|----------|
| `extensions/index.ts` | Entry point — registers tools, commands, hooks |
| `lib/squad-parser.ts` | Parser for squad.yaml and agent .md files |
| `lib/agent-adapter.ts` | Converts squad agents to Pi SDK format |
| `skills/squad-loader/SKILL.md` | Skill discovery for the LLM |

## Troubleshooting

### `/squad list` shows nothing
- Check that `~/squads/` exists and contains directories with `squad.yaml`
- Run `ls ~/squads/*/squad.yaml` to verify

### Extension not loading
- Verify the path in `~/.gsd/agent/settings.json` is correct
- Check that `npm install` was run inside the extension directory
- Restart GSD (`gsd`) after changing settings.json

### Login issues
- GSD-PI uses OAuth (Pro/Max subscription), not API keys
- Run `/login` inside GSD interactive mode
- Select "Anthropic" as the provider

## License

MIT
