/**
 * Packaging contract tests.
 *
 * Responsibility: pin the properties of the published package that are easy to break
 * silently, because a mistake here only shows up for someone installing the package —
 * not for anyone running the tests.
 *
 * The specific regression this guards against: `prepare: "npm run build"`. `prepare`
 * runs when a package is installed from a git URL, where the sources and devDependencies
 * may be absent, so installing it could fail in the consumer's environment. `prepack` is
 * the hook that matters, because it runs when the tarball is built and `files: ["build"]`
 * requires the build to exist by then.
 */
import { describe, expect, test } from "@jest/globals"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url))
const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
  name: string
  bin: Record<string, string>
  files: string[]
  exports: Record<string, unknown>
  main?: string
  types?: string
  engines?: Record<string, string>
  scripts: Record<string, string>
}

describe("packaging metadata", () => {
  test("no install-time build hook", () => {
    expect(pkg.scripts.prepare).toBeUndefined()
    expect(pkg.scripts.prepack).toBe("npm run build")
  })

  test("declares the Node range CI exercises", () => {
    expect(pkg.engines?.node).toBeDefined()
    // The lowest supported major must match the CI matrix, which is where the claim is
    // actually tested.
    const ci = readFileSync(`${root}/.github/workflows/ci.yml`, "utf8")
    const floor = (pkg.engines?.node ?? "").replace(/[^\d.]/g, "").split(".")[0]
    expect(floor).not.toBe("")
    expect(ci).toContain(`node: [${floor},`)
  })

  test("ships the build output and nothing else", () => {
    expect(pkg.files).toContain("build")
    expect(pkg.files.some((entry) => entry.startsWith("src"))).toBe(false)
  })

  test("the library entry is the side-effect-free module, not the CLI", () => {
    // `build/index.js` runs the server on import; it belongs on `bin`, never on `main`,
    // or importing the package would start a process.
    expect(pkg.main).toBe("./build/server.js")
    expect(pkg.types).toBe("./build/server.d.ts")
    expect(pkg.bin["stackoverflow-mcp"]).toBe("./build/index.js")
    expect(JSON.stringify(pkg.exports["."])).toContain("build/server.js")
  })
})

describe("deployment artifacts", () => {
  test("the templated unit has no unrendered placeholder beyond its own syntax", () => {
    const unit = readFileSync(`${root}/deploy/stackoverflow-mcp.service.template`, "utf8")
    const placeholders = new Set([...unit.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))
    // Exactly the placeholders its own instructions tell the reader to substitute.
    expect([...placeholders].sort()).toEqual(["APP_DIR", "NODE_BIN", "PORT", "USER"])
  })

  test("the templated unit stops within the server's shutdown deadline", () => {
    const unit = readFileSync(`${root}/deploy/stackoverflow-mcp.service.template`, "utf8")
    expect(unit).toContain("KillSignal=SIGTERM")
    // A stop timeout below the server's own deadline would SIGKILL a draining process.
    const timeout = /TimeoutStopSec=(\d+)/.exec(unit)?.[1]
    const deadline = /SHUTDOWN_TIMEOUT_MS[^\n]*default (\d+)/i.exec(
      readFileSync(`${root}/README.md`, "utf8")
    )?.[1]
    expect(Number(timeout)).toBeGreaterThan(0)
    if (deadline !== undefined) {
      expect(Number(timeout) * 1000).toBeGreaterThan(Number(deadline))
    }
  })

  test("the container build excludes the host's node_modules", () => {
    const ignore = readFileSync(`${root}/.dockerignore`, "utf8")
    expect(ignore).toMatch(/^node_modules$/m)
    // The environment file holds the API key and the auth token.
    expect(ignore).toMatch(/^\.env$/m)
  })

  test("docker and systemd instructions exist for the documented modes", () => {
    const readme = readFileSync(`${root}/README.md`, "utf8")
    expect(readme).toContain("### Docker")
    expect(readme).toContain("### systemd")
    expect(existsSync(`${root}/Dockerfile`)).toBe(true)
  })
})
