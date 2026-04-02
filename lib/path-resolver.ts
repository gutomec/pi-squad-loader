/**
 * path-resolver.ts — Automatic path detection for cross-platform Pi/squads
 *
 * Discovers:
 * - GSD executable (no manual GSD_BIN_PATH needed)
 * - Squad directories (global + project local)
 * - Cache directories
 *
 * Works on macOS, Linux, Windows without environment variables.
 */

import { existsSync } from "fs";
import { join, resolve } from "path";
import * as os from "os";
import { spawnSync } from "child_process";

/**
 * Find the GSD executable in standard OS paths
 * Looks in PATH first, then common installation locations
 */
export function findGsdBinary(): string | null {
  const platform = process.platform;
  const isWindows = platform === "win32";
  const exeName = isWindows ? "gsd.exe" : "gsd";

  // Check if GSD_BIN_PATH is explicitly set (for backwards compatibility)
  if (process.env.GSD_BIN_PATH) {
    if (existsSync(process.env.GSD_BIN_PATH)) {
      return process.env.GSD_BIN_PATH;
    }
  }

  // Try to find in PATH
  try {
    const result = spawnSync(isWindows ? "where" : "which", [exeName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.stdout?.trim()) {
      const path = result.stdout.trim().split("\n")[0];
      if (existsSync(path)) return path;
    }
  } catch {
    /* continue */
  }

  // Standard macOS locations
  if (platform === "darwin") {
    const candidates = [
      "/opt/homebrew/bin/gsd", // Apple Silicon
      "/usr/local/bin/gsd", // Intel Mac
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  // Standard Linux locations
  if (platform === "linux") {
    const candidates = [
      "/usr/local/bin/gsd",
      "/usr/bin/gsd",
      `${process.env.HOME || ""}/.local/bin/gsd`,
    ];
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
  }

  // Windows standard locations
  if (isWindows) {
    const candidates = [
      `C:\\Program Files\\GSD\\gsd.exe`,
      `C:\\Program Files (x86)\\GSD\\gsd.exe`,
      join(process.env.ProgramFiles || "", "GSD", "gsd.exe"),
      join(process.env["ProgramFiles(x86)"] || "", "GSD", "gsd.exe"),
    ];
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * Find all squad directories (global + local project)
 * Returns array of paths in search order
 */
export function findSquadDirectories(projectCwd?: string): string[] {
  const dirs: string[] = [];
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();

  // 1. Global user squads directory
  const globalSquads = resolve(home, "squads");
  if (existsSync(globalSquads)) {
    dirs.push(globalSquads);
  }

  // 2. Global .gsd/squads directory
  const gsdSquads = resolve(home, ".gsd", "squads");
  if (existsSync(gsdSquads)) {
    dirs.push(gsdSquads);
  }

  // 3. Project-local squads (if projectCwd provided)
  if (projectCwd) {
    const projectSquads = resolve(projectCwd, ".squads");
    if (existsSync(projectSquads)) {
      dirs.push(projectSquads);
    }

    const projectGsdSquads = resolve(projectCwd, ".gsd", "squads");
    if (existsSync(projectGsdSquads)) {
      dirs.push(projectGsdSquads);
    }
  }

  // Remove duplicates while preserving order
  return Array.from(new Set(dirs));
}

/**
 * Resolve Pi agent cache directory
 * Follows standard .gsd structure
 */
export function getAgentsCacheDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return resolve(home, ".gsd", "agent", "agents");
}

/**
 * Get runtime state directory
 * Used for storing workflow runs, checkpoints, artifacts
 */
export function getStateDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return resolve(home, ".gsd", "squad-state");
}

/**
 * Verify GSD is available and working
 */
export function verifyGsdInstallation(): { available: boolean; path?: string; error?: string } {
  const gsdPath = findGsdBinary();
  if (!gsdPath) {
    return {
      available: false,
      error: "GSD executable not found. Install GSD-2 from https://github.com/gsd-build/GSD-2",
    };
  }

  // Try to run gsd --version
  try {
    const result = spawnSync(gsdPath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0 || result.stdout?.includes("gsd") || result.stdout?.includes("GSD")) {
      return { available: true, path: gsdPath };
    }
  } catch (err) {
    return {
      available: false,
      path: gsdPath,
      error: `GSD found but not working: ${err}`,
    };
  }

  return {
    available: false,
    path: gsdPath,
    error: "GSD executable found but not responding to --version",
  };
}
