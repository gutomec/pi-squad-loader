/**
 * validation.ts — v3
 *
 * Real validation execution engine. Replaces v2's DEFERRED validation.
 * Validates agent output against JSON Schemas (via ajv in-process) and
 * evaluates JS assertions. Never returns DEFERRED.
 */

import Ajv from "ajv";
import { existsSync, readFileSync } from "fs";
import type { V2StepValidation } from "./squad-parser.js";

// ─── Types ───────────────────────────────────────────────────

export interface ValidationResult {
  passed: boolean;
  schema_result: "PASS" | "FAIL" | "SKIP";
  schema_errors: string[];
  assertion_results: AssertionResult[];
  retryable: boolean;
  duration_ms: number;
}

export interface AssertionResult {
  expression: string;
  result: "PASS" | "FAIL";
  error?: string;
}

// ─── JSON Extraction ─────────────────────────────────────────

/**
 * Extract JSON from agent output. Tries 4 strategies in order:
 * 1. Parse the entire output as JSON
 * 2. Extract from fenced code block (```json ... ```)
 * 3. First { to last }
 * 4. First [ to last ]
 */
export function extractJson(output: string): any | null {
  if (!output || typeof output !== "string") return null;

  const trimmed = output.trim();
  if (!trimmed) return null;

  // Strategy 1: try the whole output
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  // Strategy 2: fenced code block
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }

  // Strategy 3: first { to last }
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    try {
      return JSON.parse(trimmed.slice(braceStart, braceEnd + 1));
    } catch {
      // continue
    }
  }

  // Strategy 4: first [ to last ]
  const bracketStart = trimmed.indexOf("[");
  const bracketEnd = trimmed.lastIndexOf("]");
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    try {
      return JSON.parse(trimmed.slice(bracketStart, bracketEnd + 1));
    } catch {
      // continue
    }
  }

  return null;
}

// ─── Validation Execution ────────────────────────────────────

/**
 * Execute validation against agent output. Never returns DEFERRED.
 *
 * @param output - Raw agent output string
 * @param validation - V2StepValidation config from workflow step
 * @param squadDir - Base dir of the squad (for resolving schema paths)
 * @returns ValidationResult with real PASS/FAIL results
 */
export function executeValidation(
  output: string,
  validation: V2StepValidation,
  squadDir: string
): ValidationResult {
  const startTime = Date.now();

  const result: ValidationResult = {
    passed: true,
    schema_result: "SKIP",
    schema_errors: [],
    assertion_results: [],
    retryable: true,
    duration_ms: 0,
  };

  // If no validation configured, skip
  if (!validation.schema && (!validation.assertions || validation.assertions.length === 0)) {
    result.duration_ms = Date.now() - startTime;
    return result;
  }

  // Extract JSON from output
  const json = extractJson(output);

  // Schema validation
  if (validation.schema) {
    if (!json) {
      result.schema_result = "FAIL";
      result.schema_errors = ["Output does not contain valid JSON. Schema validation requires JSON output."];
      result.passed = false;
    } else {
      const schemaPath = validation.schema.startsWith("/")
        ? validation.schema
        : `${squadDir}/${validation.schema}`;

      if (!existsSync(schemaPath)) {
        // Schema file not found — still fail, don't silently skip
        result.schema_result = "FAIL";
        result.schema_errors = [`Schema file not found: ${schemaPath}`];
        result.passed = false;
      } else {
        try {
          const schemaContent = readFileSync(schemaPath, "utf8");
          const schema = JSON.parse(schemaContent);
          const ajv = new Ajv({ allErrors: true, strict: false });
          const valid = ajv.validate(schema, json);

          if (valid) {
            result.schema_result = "PASS";
          } else {
            result.schema_result = "FAIL";
            result.schema_errors = (ajv.errors || []).map(
              (e) => `${e.instancePath || "/"} ${e.message}${e.params ? ` (${JSON.stringify(e.params)})` : ""}`
            );
            result.passed = false;
          }
        } catch (e: any) {
          result.schema_result = "FAIL";
          result.schema_errors = [`Schema parsing/validation error: ${e.message}`];
          result.passed = false;
        }
      }
    }
  }

  // Assertion evaluation
  if (validation.assertions && validation.assertions.length > 0) {
    if (!json) {
      // All assertions fail if no JSON
      for (const assertion of validation.assertions) {
        result.assertion_results.push({
          expression: assertion,
          result: "FAIL",
          error: "No JSON found in output to evaluate assertion against",
        });
      }
      result.passed = false;
    } else {
      for (const assertion of validation.assertions) {
        try {
          // Use Function constructor instead of eval for slightly better isolation
          const fn = new Function("output", `"use strict"; return (${assertion});`);
          const passed = fn(json);

          result.assertion_results.push({
            expression: assertion,
            result: passed ? "PASS" : "FAIL",
            error: passed ? undefined : `Assertion returned falsy: ${JSON.stringify(passed)}`,
          });

          if (!passed) result.passed = false;
        } catch (e: any) {
          result.assertion_results.push({
            expression: assertion,
            result: "FAIL",
            error: `Assertion error: ${e.message}`,
          });
          result.passed = false;
        }
      }
    }
  }

  result.duration_ms = Date.now() - startTime;
  return result;
}

// ─── Retry Prompt Builder ────────────────────────────────────

/**
 * Build a retry prompt that gives the agent specific error feedback.
 */
export function buildRetryPrompt(
  originalTask: string,
  validationResult: ValidationResult,
  attempt: number,
  maxRetries: number
): string {
  const sections: string[] = [];

  sections.push(`## ⚠️ Retry (attempt ${attempt}/${maxRetries}) — Previous output failed validation\n`);

  if (validationResult.schema_result === "FAIL") {
    sections.push("### Schema Validation Errors");
    for (const err of validationResult.schema_errors) {
      sections.push(`- ${err}`);
    }
    sections.push("");
  }

  const failedAssertions = validationResult.assertion_results.filter((a) => a.result === "FAIL");
  if (failedAssertions.length > 0) {
    sections.push("### Failed Assertions");
    for (const a of failedAssertions) {
      sections.push(`- \`${a.expression}\` — ${a.error || "returned false"}`);
    }
    sections.push("");
  }

  sections.push("### Original Task");
  sections.push(originalTask);
  sections.push("");
  sections.push("### Instructions");
  sections.push("Fix the validation errors listed above. Your output MUST pass all schema and assertion checks.");
  sections.push("Do NOT repeat the same approach that failed. Adjust your output structure to match the required schema.");

  return sections.join("\n");
}

// ─── Validation Summary ──────────────────────────────────────

/**
 * Format a human-readable validation summary.
 */
export function formatValidationSummary(result: ValidationResult): string {
  const parts: string[] = [];

  parts.push(`Schema: ${result.schema_result}`);

  if (result.assertion_results.length > 0) {
    const passed = result.assertion_results.filter((a) => a.result === "PASS").length;
    parts.push(`Assertions: ${passed}/${result.assertion_results.length}`);
  }

  if (result.duration_ms > 0) {
    parts.push(`${result.duration_ms}ms`);
  }

  return parts.join(", ");
}
