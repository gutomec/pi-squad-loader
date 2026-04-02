# pi-squad-loader ⚡

> GSD-PI extension v3: Harness-engineered squad runtime with real validation gates, doom loop detection, Ralph Loop retry, filesystem collaboration, DAG execution, execution traces, and context compaction.

## What is this?

A [GSD-2](https://github.com/gsd-build/GSD-2) extension that adds squad management tools to Pi. Load, activate, dispatch, and run multi-agent squads with full v3 harness engineering.

**Key difference from v1/v2:** Zero configuration! Auto-detects GSD installation and squad directories on any OS (macOS, Linux, Windows).

## What's New in v3

| Feature | v1 loader | v2 loader | v3 loader |
|---|---|---|---|
| Version detection | ❌ | v1/v2 | **v1/v2/v3** |
| Validation | ❌ | DEFERRED (shell) | **Real in-process (ajv)** |
| Retry on fail | ❌ | Simple | **Structured error feedback** |
| Harness parsing | ❌ | ❌ | **Full harness config** |
| Doom loop detection | ❌ | ❌ | **Runtime (Phase B)** |
| Ralph loop | ❌ | ❌ | **Fresh context retry (Phase B)** |
| Context compaction | ❌ | ❌ | **key-fields/truncate/summarize** |
| Filesystem artifacts | ❌ | ❌ | **Read/write from disk** |
| Execution traces | ❌ | ❌ | **Step-level JSONL traces** |
| Model routing | ❌ | Per-agent | **Reasoning sandwich (phases)** |
| DAG workflows | ❌ | ❌ | **Dependency-based execution** |

## Installation

Installed automatically with [GSD-2](https://github.com/gsd-build/GSD-2). No manual setup needed!

```bash
# GSD-2 installation (includes pi-squad-loader)
git clone https://github.com/gsd-build/GSD-2
cd GSD-2
npm install
gsd --version  # Verify installation
```

## Auto-Discovery (Zero Configuration!)

**Nothing to configure.** The loader automatically:

### 1. Finds GSD executable
- **macOS:** `/opt/homebrew/bin/gsd`, `/usr/local/bin/gsd`
- **Linux:** `/usr/local/bin/gsd`, `/usr/bin/gsd`, `~/.local/bin/gsd`
- **Windows:** `C:\Program Files\GSD\gsd.exe`, etc.
- **Fallback:** Searches PATH if not in standard locations

### 2. Discovers squad directories
Searches in this order (all platforms):
1. Global user: `~/.squads`
2. Global GSD: `~/.gsd/squads`
3. Project-local: `.squads/`
4. Project GSD: `.gsd/squads/`

Return only directories that exist. Deduplicates squads by name.

## Pi Tools Provided

### Core tools (v1+)
| Tool | Description |
|---|---|
| `squad_list` | List all discovered squads with version detection |
| `squad_activate` | Activate a squad, write agents to Pi cache |
| `squad_dispatch` | Dispatch an agent with task + context |
| `squad_workflow` | Run a complete workflow as agent chain |
| `squad_status` | Show activated squads and agents |
| `squad_inject` | Inject artifacts into GSD context |

### v3 tools
| Tool | Description |
|---|---|
| `squad_validate_output` | Validate arbitrary output against a squad schema |

## Architecture

```
extensions/index.ts       — Pi extension entry point, tool registration
lib/path-resolver.ts      — Auto-detection of GSD binary and squad dirs (NEW!)
lib/squad-parser.ts       — YAML parser for v1/v2/v3 manifests
lib/validation.ts         — Real validation engine with ajv
lib/v3-runtime.ts         — Runtime: state, checkpoints, artifacts, traces
lib/agent-adapter.ts      — Agent → Pi SDK adapter
```

Key feature: `path-resolver.ts` handles all OS-specific path logic so users never need environment variables.

## Version Detection

The parser automatically detects squad versions:

| Version | Detection Rule |
|---|---|
| v1 | No `state`, no `harness`, no `model_strategy`, no `components.schemas` |
| v2 | Has `state` or `model_strategy` or `components.schemas` — no `harness` |
| v3 | Has `harness` key in squad.yaml |

## Validation Engine

v3 uses real in-process validation via ajv (no shell commands):

```typescript
import { extractJson, executeValidation } from './lib/validation.js';

// 4-strategy JSON extraction
const json = extractJson(agentOutput);

// Schema + assertion validation
const result = executeValidation(output, {
  schema: 'schemas/analysis.json',
  assertions: ['output.findings.length > 0'],
  on_fail: 'retry',
  max_retries: 3
}, squadDir);

// result.passed, result.schema_result, result.assertion_results
```

## Tests

```bash
# Run validation + version detection tests (101 assertions)
npx tsx test-validation.mjs
```

## Compatibility

- ✅ v1 squads load and run unchanged
- ✅ v2 squads load and run with validation gates
- ✅ v3 squads get full harness features
- ✅ TypeScript compiles clean (`tsc --noEmit`)

## Author

**Luiz Gustavo Vieira Rodrigues** ([@gutomec](https://github.com/gutomec))

## License

MIT
