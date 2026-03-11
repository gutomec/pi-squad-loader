---
name: squad-loader
description: Load and manage Squads ecosystem agents as native GSD-PI subagents. Use when you need specialized domain expertise (design, marketing, copy, pricing, architecture) from squad agents within GSD autonomous execution.
---

# Squad Loader

Load specialized squad agents into GSD-PI as native subagents.

## When to Use

- You need **domain expertise** that general-purpose agents lack (design systems, marketing strategy, copywriting, pricing science, legal analysis, etc.)
- A GSD slice requires **specialist input** before implementation (e.g., brand identity before building UI, offer strategy before building sales page)
- You want to run a **multi-agent workflow** where each specialist contributes their expertise sequentially

## Available Commands

| Command | Purpose |
|---------|---------|
| `/squad list` | Discover all available squads in ~/squads/ |
| `/squad agents {name}` | See agents and their capabilities in a squad |
| `/squad activate {name}` | Load squad agents as Pi subagents |
| `/squad run {name} {workflow}` | Run a complete multi-agent workflow |
| `/squad inject {path}` | Feed artifact into .gsd/ context |
| `/squad status` | Show currently active squads |

## Available Tools

| Tool | Purpose |
|------|---------|
| `squad_list` | List squads (filterable by name/tag) |
| `squad_activate` | Activate a squad's agents |
| `squad_dispatch` | Send task to a specific squad agent |
| `squad_workflow` | Run workflow as sequential agent chain |
| `squad_inject` | Inject artifact into GSD context |
| `squad_status` | Check activation status |

## Typical Flow

```
1. squad_list               → See what's available
2. squad_activate "name"    → Load agents
3. squad_dispatch agent task → Get specialist output
4. squad_inject artifact     → Feed into GSD context
5. Continue with /gsd auto   → GSD uses the enriched context
```

## Example: Building a Landing Page

```
# 1. Activate design + marketing squads
squad_activate "brandcraft"
squad_activate "sales-funnel-masters"

# 2. Extract design system
squad_dispatch "squad--brandcraft--bc-extractor" "Analyze https://example.com and extract design tokens"

# 3. Get offer strategy
squad_dispatch "squad--sales-funnel-masters--sfm-hormozi" "Create Grand Slam Offer for SaaS product targeting developers"

# 4. Inject artifacts
squad_inject "design-tokens.md" research
squad_inject "offer-stack.md" research

# 5. GSD auto picks up enriched context
/gsd auto
```

## Squad Agent Naming

Activated agents follow the pattern: `squad--{squad-name}--{agent-id}`

Examples:
- `squad--brandcraft--bc-extractor`
- `squad--brandcraft--bc-renderer`
- `squad--sales-funnel-masters--sfm-hormozi`
- `squad--sales-funnel-masters--sfm-brunson`
- `squad--gsd-bridge--gsb-collector`
