/**
 * Package version, read once from `package.json`.
 *
 * Responsibility: the single source of truth for the version reported by the
 * MCP server info, the `stackoverflow://status` resource and the HTTP `/health`
 * endpoint. Previously the string `'0.2.0'` was duplicated in three places, so a
 * release bump could leave them disagreeing.
 *
 * The value is resolved relative to this module so it works from both `src/`
 * (tests, via ts-jest) and `build/` (the published output), which sit one
 * directory below the package root in both cases.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

interface PackageManifest {
  version?: unknown
}

function readVersion(): string {
  try {
    const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url))
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest
    return typeof manifest.version === "string" && manifest.version.length > 0
      ? manifest.version
      : "0.0.0"
  } catch {
    // Never let a missing manifest stop the server from starting.
    return "0.0.0"
  }
}

/** The package version, e.g. `0.2.0`. */
export const VERSION: string = readVersion()

/** The MCP server name advertised to clients. */
export const SERVER_NAME = "stackoverflow-mcp"
