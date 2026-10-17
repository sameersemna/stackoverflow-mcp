/**
 * Configuration completeness tests.
 *
 * Responsibility: keep `config.ts`, the environment and the documentation in step.
 *
 * `config.ts` is the only module allowed to read `process.env`, so the set of variables
 * the server understands is exactly what that file parses. Three things can drift, and
 * each is checked here:
 *
 * 1. a variable read somewhere *else*, bypassing validation and its default;
 * 2. a variable in `config.ts` that the README does not document, so nobody can find it;
 * 3. a variable in the README that `config.ts` does not read, so the documentation lies.
 *
 * The README check is the Phase 10 gate, written now so that later documentation work is
 * verified rather than hopeful.
 */
import { describe, expect, test } from "@jest/globals"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url))

/**
 * Environment variables a script reads.
 *
 * The opt-in live check has its own switches (`SO_LIVE`, `SO_LIVE_BUDGET`), which are
 * documented but are not server configuration: the server never reads them. Reading
 * them out of the script keeps them in the known set without hardcoding names that
 * would then silently rot.
 */
function envVarsReadByScript(file: string): string[] {
  const source = readFileSync(`${root}/${file}`, "utf8")
  return [...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1])
}

/** Every `.ts` file under `src/`, excluding the tests themselves. */
function sourceFiles(dir = `${root}/src`): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`
    if (statSync(full).isDirectory()) {
      if (entry !== "__tests__") {
        found.push(...sourceFiles(full))
      }
    } else if (entry.endsWith(".ts")) {
      found.push(full)
    }
  }
  return found
}

/** Environment variable names read via `process.env.X` or `process.env['X']`. */
function envVarsReadBy(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    names.add(match[1])
  }
  for (const match of source.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) {
    names.add(match[1])
  }
  return [...names].sort()
}

describe("configuration is read in exactly one place", () => {
  test("only config.ts reads process.env", () => {
    const offenders = sourceFiles()
      .filter((file) => !file.endsWith("/config.ts"))
      .map((file) => ({ file, vars: envVarsReadBy(readFileSync(file, "utf8")) }))
      .filter((entry) => entry.vars.length > 0)
      .map((entry) => `${entry.file.replace(root, "")} → ${entry.vars.join(", ")}`)

    // Reading env elsewhere bypasses validation, the documented default and the
    // single-source-of-truth rule that Phase 7 relies on.
    expect(offenders).toEqual([])
  })

  test("every variable config.ts reads is declared in its schema", () => {
    const config = readFileSync(`${root}/src/config.ts`, "utf8")
    const read = envVarsReadBy(config)
    // `safeParse` is given an object literal mapping each name; the schema declares the
    // same names as optional keys. Both must mention every variable.
    const missingFromSchema = read.filter(
      (name) => !new RegExp(`^\\s{2}${name}:`, "m").test(config)
    )

    expect(missingFromSchema).toEqual([])
    expect(read.length).toBeGreaterThan(15)
  })
})

describe("documentation matches the configuration", () => {
  test("every environment variable in config.ts is documented in the README", () => {
    const config = readFileSync(`${root}/src/config.ts`, "utf8")
    const readme = readFileSync(`${root}/README.md`, "utf8")
    const read = envVarsReadBy(config)

    const undocumented = read.filter((name) => !readme.includes(name))

    // A variable nobody can discover is a variable nobody can use.
    expect(undocumented).toEqual([])
  })

  test("the README does not document variables that do not exist", () => {
    const config = readFileSync(`${root}/src/config.ts`, "utf8")
    const readme = readFileSync(`${root}/README.md`, "utf8")
    // Only names that look like this server's variables, so unrelated uppercase words
    // in prose are not mistaken for configuration.
    const documented = new Set(
      [...readme.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((match) => match[1])
    )
    const scriptVars = envVarsReadByScript("scripts/live-check.mjs")
    const known = new Set([...envVarsReadBy(config), ...scriptVars])
    // The other direction: a script variable nobody documents is equally unusable.
    const undocumentedScriptVars = scriptVars.filter((name) => !readme.includes(name))
    // Words that are legitimately in the README but are not environment variables.
    const notEnvironmentVariables = new Set([
      "README",
      "MCP",
      "API",
      "JSON",
      "HTTP",
      "HTTPS",
      "SSE",
      "URL",
      "CLI",
      "UTF",
      "MIT",
      "IP",
      "ID",
      "IDS",
      "TTL",
      "LRU",
      "FIFO",
      "DNS",
      "CORS",
      "TODO",
      "NOTE",
      "IMPORTANT",
      "PROGRESS",
      "CHANGELOG",
      "SO",
      "TTY",
      "ENV",
      "PID",
      "LTS",
      "AMD",
      "ARM",
      "OS",
      "AI",
      "PDF",
    ])
    // Anything that looks like a variable is either known or one of the allowed words.
    const suspicious = [...documented].filter(
      (word) =>
        !known.has(word) &&
        !notEnvironmentVariables.has(word) &&
        /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(word)
    )

    expect(suspicious).toEqual([])
    expect(undocumentedScriptVars).toEqual([])
  })
})
