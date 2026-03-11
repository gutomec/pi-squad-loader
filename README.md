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

## Installation

### Via Pi package manager (recommended)

```bash
pi install npm:pi-squad-loader
```

### Via git

```bash
pi install git:github.com/gutomec/pi-squad-loader@v1
```

### Via settings.json (local development)

```json
{
  "extensions": ["/path/to/pi-squad-loader/extensions/index.ts"]
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

```
# 1. Activate design + marketing squads
/squad activate brandcraft
/squad activate sales-funnel-masters

# 2. Extract design system
squad_dispatch "squad--brandcraft--bc-extractor" "Analyze https://example.com and extract design tokens"

# 3. Get offer strategy
squad_dispatch "squad--sales-funnel-masters--sfm-hormozi" "Create Grand Slam Offer for SaaS targeting developers"

# 4. Inject artifacts into GSD context
squad_inject "design-tokens.md" research
squad_inject "offer-stack.md" research

# 5. GSD auto picks up enriched context
/gsd auto
```

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

## Requirements

- GSD-PI (`npm install -g gsd-pi`)
- Node.js >= 20.6.0
- Squads in `~/squads/` with valid `squad.yaml`

## License

MIT
