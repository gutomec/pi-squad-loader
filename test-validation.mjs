/**
 * test-validation.mjs — v3 validation engine + version detection tests
 *
 * Tests: JSON extraction (4 strategies), schema validation (pass/fail),
 * assertion evaluation, retry prompt building, format summary,
 * version detection (v1/v2/v3), harness parsing, discoverSquads with fixtures.
 *
 * Run: node --import tsx test-validation.mjs
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Import from TS sources via tsx loader
import {
  extractJson,
  executeValidation,
  buildRetryPrompt,
  formatValidationSummary,
} from "./lib/validation.ts";

import {
  detectSquadVersion,
  discoverSquads,
} from "./lib/squad-parser.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "tests", "fixtures");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── extractJson ─────────────────────────────────────────────

console.log("\n🔬 extractJson — 4 strategies\n");

// Strategy 1: whole output is JSON
{
  const result = extractJson('{"key": "value"}');
  assert(result !== null && result.key === "value", "Strategy 1: parse whole output as JSON");
}

// Strategy 1: JSON array
{
  const result = extractJson('[1, 2, 3]');
  assert(Array.isArray(result) && result.length === 3, "Strategy 1: parse array");
}

// Strategy 2: fenced code block
{
  const output = `Here is the analysis:\n\n\`\`\`json\n{"title": "Report", "score": 95}\n\`\`\`\n\nDone.`;
  const result = extractJson(output);
  assert(result !== null && result.title === "Report" && result.score === 95, "Strategy 2: fenced code block");
}

// Strategy 2: fenced block without json label
{
  const output = "Look:\n```\n{\"a\": 1}\n```\nEnd";
  const result = extractJson(output);
  assert(result !== null && result.a === 1, "Strategy 2: fenced block without json label");
}

// Strategy 3: first { to last }
{
  const output = "Some preamble text {\"nested\": true, \"data\": [1,2]} and trailing text";
  const result = extractJson(output);
  assert(result !== null && result.nested === true, "Strategy 3: first { to last }");
}

// Strategy 4: first [ to last ]
{
  const output = "Results: [\"alpha\", \"beta\", \"gamma\"] — end";
  const result = extractJson(output);
  assert(Array.isArray(result) && result[0] === "alpha" && result.length === 3, "Strategy 4: first [ to last ]");
}

// Edge cases
{
  assert(extractJson(null) === null, "null input → null");
  assert(extractJson("") === null, "empty string → null");
  assert(extractJson("   ") === null, "whitespace → null");
  assert(extractJson("no json here at all") === null, "no JSON anywhere → null");
  assert(extractJson(undefined) === null, "undefined input → null");
}

// ─── executeValidation — schema pass ─────────────────────────

console.log("\n🔬 executeValidation — schema validation\n");

{
  const output = JSON.stringify({
    title: "Security Analysis",
    findings: [{ id: "F1", description: "XSS in /login", severity: "high" }],
    severity: "high",
    summary: "One critical finding.",
  });

  const validation = {
    schema: "schemas/analysis.json",
    assertions: [],
    on_fail: "retry",
    max_retries: 2,
  };

  const result = executeValidation(output, validation, join(fixturesDir, "v3-squad"));
  assertEq(result.passed, true, "Schema validation PASS for valid data");
  assertEq(result.schema_result, "PASS", "schema_result is PASS");
  assertEq(result.schema_errors.length, 0, "No schema errors");
  assert(result.duration_ms >= 0, "duration_ms is set");
}

// ─── executeValidation — schema fail ─────────────────────────

{
  // Missing required 'findings' field
  const output = JSON.stringify({
    title: "Incomplete",
    severity: "low",
  });

  const validation = {
    schema: "schemas/analysis.json",
    assertions: [],
    on_fail: "retry",
  };

  const result = executeValidation(output, validation, join(fixturesDir, "v3-squad"));
  assertEq(result.passed, false, "Schema validation FAIL for missing required field");
  assertEq(result.schema_result, "FAIL", "schema_result is FAIL");
  assert(result.schema_errors.length > 0, "Has schema error messages");
  assert(result.schema_errors.some(e => e.includes("findings")), "Error mentions 'findings'");
}

// ─── executeValidation — no JSON in output ───────────────────

{
  const validation = {
    schema: "schemas/analysis.json",
    assertions: [],
    on_fail: "abort",
  };

  const result = executeValidation("This is just plain text, no JSON.", validation, join(fixturesDir, "v3-squad"));
  assertEq(result.passed, false, "FAIL when output has no JSON");
  assertEq(result.schema_result, "FAIL", "schema_result FAIL for no JSON");
  assert(result.schema_errors[0].includes("does not contain valid JSON"), "Error says no JSON");
}

// ─── executeValidation — schema file not found ───────────────

{
  const validation = {
    schema: "schemas/nonexistent.json",
    assertions: [],
    on_fail: "abort",
  };

  const result = executeValidation('{"a":1}', validation, join(fixturesDir, "v3-squad"));
  assertEq(result.passed, false, "FAIL when schema file not found");
  assert(result.schema_errors[0].includes("not found"), "Error mentions not found");
}

// ─── executeValidation — assertions ──────────────────────────

console.log("\n🔬 executeValidation — assertions\n");

{
  const output = JSON.stringify({
    title: "Report",
    findings: [{ id: "F1", description: "Bug", severity: "high" }],
    severity: "high",
    count: 5,
  });

  const validation = {
    on_fail: "retry",
    assertions: [
      "output.title === 'Report'",
      "output.findings.length > 0",
      "output.count >= 5",
    ],
  };

  const result = executeValidation(output, validation, fixturesDir);
  assertEq(result.passed, true, "All assertions PASS");
  assertEq(result.assertion_results.length, 3, "3 assertion results");
  assert(result.assertion_results.every(a => a.result === "PASS"), "Every assertion is PASS");
}

{
  const output = JSON.stringify({ title: "Report", count: 2 });

  const validation = {
    on_fail: "retry",
    assertions: [
      "output.title === 'Report'",
      "output.count > 10",  // this will fail
    ],
  };

  const result = executeValidation(output, validation, fixturesDir);
  assertEq(result.passed, false, "FAIL when assertion fails");
  assertEq(result.assertion_results[0].result, "PASS", "First assertion passes");
  assertEq(result.assertion_results[1].result, "FAIL", "Second assertion fails");
}

// assertions with no JSON
{
  const validation = {
    on_fail: "retry",
    assertions: ["output.title === 'x'"],
  };

  const result = executeValidation("plain text", validation, fixturesDir);
  assertEq(result.passed, false, "Assertions FAIL when no JSON");
  assertEq(result.assertion_results[0].result, "FAIL", "Assertion result is FAIL");
  assert(result.assertion_results[0].error.includes("No JSON"), "Error says no JSON");
}

// invalid assertion expression
{
  const output = JSON.stringify({ x: 1 });
  const validation = {
    on_fail: "retry",
    assertions: ["output.x === 1", "this is not valid javascript!!!"],
  };

  const result = executeValidation(output, validation, fixturesDir);
  assertEq(result.assertion_results[0].result, "PASS", "Valid assertion passes");
  assertEq(result.assertion_results[1].result, "FAIL", "Invalid expression fails");
  assert(result.assertion_results[1].error.includes("error"), "Has error message");
}

// ─── executeValidation — no validation configured ────────────

{
  const validation = { on_fail: "abort" };
  const result = executeValidation('{"a":1}', validation, fixturesDir);
  assertEq(result.passed, true, "PASS when no validation configured");
  assertEq(result.schema_result, "SKIP", "schema_result is SKIP");
}

// ─── executeValidation — schema + assertions combined ────────

{
  const output = JSON.stringify({
    title: "Combined",
    findings: [{ id: "F1", description: "Test", severity: "low" }],
    severity: "low",
    summary: "ok",
  });

  const validation = {
    schema: "schemas/analysis.json",
    assertions: [
      "output.title === 'Combined'",
      "output.findings.length === 1",
      "output.severity === 'low'",
    ],
    on_fail: "retry",
  };

  const result = executeValidation(output, validation, join(fixturesDir, "v3-squad"));
  assertEq(result.passed, true, "Schema + assertions both PASS");
  assertEq(result.schema_result, "PASS", "Schema PASS");
  assertEq(result.assertion_results.length, 3, "3 assertion results");
}

// ─── buildRetryPrompt ────────────────────────────────────────

console.log("\n🔬 buildRetryPrompt\n");

{
  const validationResult = {
    passed: false,
    schema_result: "FAIL",
    schema_errors: ["/ must have required property 'findings'"],
    assertion_results: [
      { expression: "output.count > 0", result: "FAIL", error: "Assertion returned falsy: false" },
    ],
    retryable: true,
    duration_ms: 12,
  };

  const prompt = buildRetryPrompt("Analyze the code", validationResult, 2, 3);
  assert(prompt.includes("Retry (attempt 2/3)"), "Has retry header with attempt count");
  assert(prompt.includes("Schema Validation Errors"), "Has schema errors section");
  assert(prompt.includes("findings"), "Mentions the missing field");
  assert(prompt.includes("Failed Assertions"), "Has failed assertions section");
  assert(prompt.includes("output.count > 0"), "Shows the failed assertion expression");
  assert(prompt.includes("Analyze the code"), "Includes original task");
  assert(prompt.includes("Fix the validation errors"), "Has fix instructions");
}

// ─── formatValidationSummary ─────────────────────────────────

console.log("\n🔬 formatValidationSummary\n");

{
  const result = {
    passed: true,
    schema_result: "PASS",
    schema_errors: [],
    assertion_results: [
      { expression: "a", result: "PASS" },
      { expression: "b", result: "PASS" },
    ],
    retryable: false,
    duration_ms: 42,
  };

  const summary = formatValidationSummary(result);
  assert(summary.includes("Schema: PASS"), "Shows schema PASS");
  assert(summary.includes("Assertions: 2/2"), "Shows assertion count");
  assert(summary.includes("42ms"), "Shows duration");
}

{
  const result = {
    passed: false,
    schema_result: "FAIL",
    schema_errors: ["err"],
    assertion_results: [
      { expression: "a", result: "PASS" },
      { expression: "b", result: "FAIL" },
    ],
    retryable: true,
    duration_ms: 7,
  };

  const summary = formatValidationSummary(result);
  assert(summary.includes("Schema: FAIL"), "Shows schema FAIL");
  assert(summary.includes("Assertions: 1/2"), "Shows partial assertion pass");
}

{
  const result = {
    passed: true,
    schema_result: "SKIP",
    schema_errors: [],
    assertion_results: [],
    retryable: false,
    duration_ms: 0,
  };

  const summary = formatValidationSummary(result);
  assert(summary.includes("Schema: SKIP"), "Shows schema SKIP");
  assert(!summary.includes("Assertions"), "No assertions section when empty");
}

// ─── detectSquadVersion ──────────────────────────────────────

console.log("\n🔬 detectSquadVersion\n");

{
  const v1 = { name: "test", components: { agents: ["a.md"] } };
  assertEq(detectSquadVersion(v1), "v1", "v1: no state, no harness");
}

{
  const v2 = { name: "test", state: { enabled: true }, model_strategy: { orchestrator: "claude" } };
  assertEq(detectSquadVersion(v2), "v2", "v2: has state + model_strategy");
}

{
  const v2schemas = { name: "test", components: { schemas: ["out.json"] } };
  assertEq(detectSquadVersion(v2schemas), "v2", "v2: has schemas in components");
}

{
  const v3 = { name: "test", harness: { doom_loop: { enabled: true } } };
  assertEq(detectSquadVersion(v3), "v3", "v3: has harness");
}

{
  // v3 wins even if state is also present
  const v3full = { name: "test", state: { enabled: true }, harness: { traces: { enabled: true } } };
  assertEq(detectSquadVersion(v3full), "v3", "v3: harness takes precedence over state");
}

// ─── discoverSquads with fixtures ────────────────────────────

console.log("\n🔬 discoverSquads — fixture detection\n");

{
  const squads = discoverSquads(fixturesDir);
  assert(squads.length >= 3, `Found ${squads.length} squads (expected ≥ 3)`);

  const v1 = squads.find(s => s.name === "test-v1-squad");
  const v2 = squads.find(s => s.name === "test-v2-squad");
  const v3 = squads.find(s => s.name === "test-v3-squad");

  assert(v1 !== undefined, "Found v1 fixture squad");
  assert(v2 !== undefined, "Found v2 fixture squad");
  assert(v3 !== undefined, "Found v3 fixture squad");

  if (v1) {
    assertEq(v1.squadVersion, "v1", "v1 squad detected as v1");
    assertEq(v1.isV2, false, "v1 isV2 = false");
    assertEq(v1.isV3, false, "v1 isV3 = false");
    assertEq(v1.harness, null, "v1 has no harness");
    assertEq(v1.modelStrategy, null, "v1 has no modelStrategy");
    assertEq(v1.stateConfig, null, "v1 has no stateConfig");
    assertEq(v1.slashPrefix, "tv1", "v1 slashPrefix = tv1");
  }

  if (v2) {
    assertEq(v2.squadVersion, "v2", "v2 squad detected as v2");
    assertEq(v2.isV2, true, "v2 isV2 = true");
    assertEq(v2.isV3, false, "v2 isV3 = false");
    assertEq(v2.harness, null, "v2 has no harness");
    assert(v2.modelStrategy !== null, "v2 has modelStrategy");
    assertEq(v2.modelStrategy?.orchestrator, "claude-sonnet-4", "v2 orchestrator = claude-sonnet-4");
    assertEq(v2.modelStrategy?.workers, "gemini-flash", "v2 workers = gemini-flash");
    assert(v2.stateConfig !== null, "v2 has stateConfig");
    assertEq(v2.stateConfig?.enabled, true, "v2 state enabled");
    assertEq(v2.stateConfig?.storage, "file", "v2 state storage = file");
    assert(v2.components.schemas.length > 0, "v2 has schemas");
  }

  if (v3) {
    assertEq(v3.squadVersion, "v3", "v3 squad detected as v3");
    assertEq(v3.isV2, true, "v3 isV2 = true (compat)");
    assertEq(v3.isV3, true, "v3 isV3 = true");
    assert(v3.harness !== null, "v3 has harness");
    assert(v3.harness?.doom_loop?.enabled === true, "v3 doom_loop enabled");
    assertEq(v3.harness?.doom_loop?.max_identical_outputs, 3, "v3 doom_loop max_identical_outputs = 3");
    assertEq(v3.harness?.doom_loop?.on_detect, "abort", "v3 doom_loop on_detect = abort");
    assert(v3.harness?.ralph_loop?.enabled === true, "v3 ralph_loop enabled");
    assertEq(v3.harness?.ralph_loop?.max_iterations, 5, "v3 ralph_loop max_iterations = 5");
    assert(v3.harness?.context_compaction?.enabled === true, "v3 context_compaction enabled");
    assertEq(v3.harness?.context_compaction?.strategy, "key-fields", "v3 compaction strategy = key-fields");
    assertEq(v3.harness?.context_compaction?.max_handoff_tokens, 4000, "v3 max_handoff_tokens = 4000");
    assert(v3.harness?.filesystem_collaboration?.enabled === true, "v3 filesystem_collaboration enabled");
    assertEq(v3.harness?.filesystem_collaboration?.artifact_dir, "artifacts", "v3 artifact_dir = artifacts");
    assert(v3.harness?.traces?.enabled === true, "v3 traces enabled");
    assertEq(v3.harness?.traces?.level, "standard", "v3 traces level = standard");
    assert(v3.modelStrategy !== null, "v3 has modelStrategy");
    assert(v3.stateConfig !== null, "v3 has stateConfig");
    assert(v3.components.schemas.length > 0, "v3 has schemas");
  }
}

// ─── Summary ─────────────────────────────────────────────────

console.log("\n" + "─".repeat(50));
console.log(`\n  Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);

if (failed > 0) {
  console.log("  ⚠️  Some tests failed!\n");
  process.exit(1);
} else {
  console.log("  🎉 All tests passed!\n");
}
