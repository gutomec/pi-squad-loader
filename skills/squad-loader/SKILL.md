---
name: squad-loader
description: Load and manage Squads ecosystem agents as native GSD-PI subagents. Use when you need specialized domain expertise (design, marketing, copy, pricing, architecture) from squad agents within GSD autonomous execution.
---

# Squad Loader

Load specialized squad agents into GSD-PI as native subagents.

## Critical Operating Rules

These rules apply every time you use squads. Violating them causes stuck workflows, spawn failures, and wasted context.

### 1. ALWAYS DISCOVER DYNAMICALLY

Squad names vary per installation. Never assume or hardcode squad names.

```
WRONG: squad_activate "brandcraft"          ← assumes squad exists
RIGHT: squad_list → read results → squad_activate "actual-name-from-list"
```

**Mandatory sequence before any squad operation:**
1. `squad_list` — see what's actually installed
2. Read the output — match squad to the task need
3. `squad_activate "name"` — using the exact name from the list
4. `squad_dispatch` or `squad_workflow` — using exact agent IDs from activation output

### 2. TASK PROMPTS = INSTRUCTIONS, NOT CODE

`squad_dispatch` `task` parameter = what the agent should DO. The agent has its own tools and reads files itself.

```
WRONG (causes spawn failures and context explosion):
  task: "Implement this migration:\nCREATE TABLE clinic_settings (\n  id uuid...\n[500 lines of SQL]"

WRONG (duplicates info that already exists):
  task: "Create this component:\nimport React from 'react'\n[300 lines of TypeScript]"

RIGHT (short, directive, references paths):
  task: "Read .gsd/milestones/M001/slices/S09/S09-PLAN.md T01. Implement the DB migration in supabase/migrations/. Run verify-s09.sh when done."

RIGHT (security review, bounded scope):
  task: "Review src/lib/admin.ts for auth bypass and injection risks. Report: file, line, severity, recommended fix."
```

**Task prompt formula:**
1. GOAL — what the agent must achieve (1-2 sentences max)
2. CONTEXT — where to find specs (file path or plan doc reference — never paste content)
3. DONE WHEN — one verifiable success criterion

**Hard limit:** If your task prompt exceeds ~2KB, you are doing it wrong. Break it up or reference files.

### 3. SELF-SUPERVISE CONTEXT BUDGET

Before dispatching a squad agent, check your own context state:
- If you've accumulated many large tool results → write a handoff note, stop, resume in a fresh context
- If a dispatch fails or returns empty → check `squad_status`, verify activation, retry with a simpler task prompt
- Never sacrifice a handoff summary for one more dispatch call

Signs you need to stop and hand off:
- You've dispatched 3+ agents and context feels full
- A dispatch returned "(no output)" or "(spawn error)"
- You're about to paste file contents into a task prompt

### 4. ONE RESPONSIBILITY PER DISPATCH

Each `squad_dispatch` = one focused goal. Never bundle unrelated tasks.

```
WRONG: "Review security AND refactor the admin module AND add tests"
RIGHT: Three separate dispatches, each with a single goal
```

### 5. WHEN TO USE SQUADS vs IMPLEMENT DIRECTLY

Use squads for domain expertise you don't have:
- Security audit / code review
- UX critique / design system extraction
- Copywriting / marketing strategy
- Architecture review
- Scientific research

Implement directly (don't use squads for):
- Routine coding tasks
- File creation and edits in known code
- Bug fixes where you already understand the root cause
- Tasks that fit in a single context window

---

## Available Tools

| Tool | Purpose |
|------|---------|
| `squad_list` | List squads — ALWAYS call this first |
| `squad_activate` | Activate a squad's agents |
| `squad_dispatch` | Send task to a specific agent |
| `squad_workflow` | Run multi-agent workflow chain |
| `squad_inject` | Inject artifact into GSD context |
| `squad_status` | Check activation status |

## Correct Flow (every time)

```
1. squad_list                    → discover what's actually installed
2. squad_activate "exact-name"   → load agents (name from step 1)
3. squad_dispatch agent task     → brief instruction, not code
4. squad_inject artifact         → feed output into GSD context if needed
5. Continue with /gsd auto       → GSD uses the enriched context
```

## Agent Naming (after activation)

Activated agents follow the pattern: `squad--{squad-name}--{agent-id}`

The exact agent IDs are shown in the `squad_activate` output. Always read them from there — never guess.

## Context for squad_workflow

`context` parameter = briefing only. Project goal, constraints, where to find specs. Not code. Not file contents.

```
GOOD context:
  "Project: Metabolic Monitor SaaS. Stack: Next.js 15, Supabase, Stripe.
   Codebase: /Users/guto/Projects/metabolic-monitor-v2.
   Specs: .gsd/milestones/M001/slices/S09/S09-PLAN.md"

BAD context:
  "[500 lines of SQL and TypeScript pasted here]"
```
