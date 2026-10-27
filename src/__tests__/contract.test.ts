/**
 * MCP contract snapshot — the compatibility tripwire for the whole hardening effort.
 *
 * Responsibility: connect a real in-memory MCP client to a real `StackOverflowServer`
 * and pin the published contract: the 5 tools with their input schemas and
 * annotations, the 2 resources and the 2 prompts.
 *
 * Rules for this suite:
 * - Later changes may only *add* to the contract; anything else needs a
 *   `CHANGELOG.md` entry and a deliberate snapshot update.
 * - The invariant assertions below (names, annotations, required params) are
 *   written in code, not only in the snapshot, so that a careless
 *   `jest -u` cannot silently drop a tool or weaken an annotation.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { describe, expect, test } from "@jest/globals"
import { StackOverflowServer } from "../server.js"

const EXPECTED_TOOL_NAMES = [
  "search_by_error",
  "search_by_tags",
  "analyze_stack_trace",
  "search_by_query",
  "search_by_question_id",
] as const

const EXPECTED_RESOURCE_URIS = ["stackoverflow://status", "stackoverflow://quota"] as const

/**
 * Prompts that must always exist. Asserted as a *subset*, because additive
 * prompts are allowed: `stackoverflow_explain_answer` was added in Phase 5 and
 * the exact set is pinned by the snapshot below.
 */
const REQUIRED_PROMPT_NAMES = [
  "stackoverflow_search",
  "stackoverflow_debug",
  "stackoverflow_explain_answer",
] as const

/**
 * Assertion helper that carries a context message.
 *
 * Jest's `expect` accepts no message argument (unlike vitest), and a bare
 * failure inside a loop over tools is hard to attribute.
 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

/** Deeply sorts object keys so snapshots do not drift on key insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, canonicalize(entryValue)]))
  }
  return value
}

async function connectInMemory(): Promise<{ client: Client }> {
  const server = new StackOverflowServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "contract-snapshot", version: "1.0.0" })

  await Promise.all([client.connect(clientTransport), server.getServer().connect(serverTransport)])

  return { client }
}

describe("MCP contract", () => {
  test("tools/list publishes the 5 documented tools", async () => {
    const { client } = await connectInMemory()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort())

    for (const tool of tools) {
      assert(tool.title, `${tool.name} must keep a title`)
      assert((tool.description?.length ?? 0) > 0, `${tool.name} must keep a non-empty description`)
    }

    await client.close()
  })

  test("every tool keeps its read-only annotations", async () => {
    const { client } = await connectInMemory()

    const { tools } = await client.listTools()

    for (const tool of tools) {
      assert(tool.annotations, `${tool.name} must declare annotations`)
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      })
    }

    await client.close()
  })

  test("tools/list input schemas are stable", async () => {
    const { client } = await connectInMemory()

    const { tools } = await client.listTools()

    const shapes = tools.map((tool) => ({
      name: tool.name,
      required: tool.inputSchema.required,
      properties: canonicalize(tool.inputSchema.properties),
    }))

    expect(canonicalize(shapes)).toMatchSnapshot()
  })

  test("resources/list publishes the 2 documented resources", async () => {
    const { client } = await connectInMemory()

    const { resources } = await client.listResources()

    expect(resources.map((resource) => resource.uri).sort()).toEqual(
      [...EXPECTED_RESOURCE_URIS].sort()
    )

    await client.close()
  })

  test("prompts/list publishes the 3 documented prompts", async () => {
    const { client } = await connectInMemory()

    const { prompts } = await client.listPrompts()

    const names = prompts.map((prompt) => prompt.name)
    for (const required of REQUIRED_PROMPT_NAMES) {
      assert(names.includes(required), `prompt ${required} must remain available`)
    }

    for (const prompt of prompts) {
      assert((prompt.arguments?.length ?? 0) > 0, `${prompt.name} must declare arguments`)
    }

    await client.close()
  })

  test("the full contract snapshot", async () => {
    const { client } = await connectInMemory()

    const [tools, resources, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listPrompts(),
    ])

    expect(
      canonicalize({
        tools: tools.tools,
        resources: resources.resources,
        prompts: prompts.prompts,
      })
    ).toMatchSnapshot()

    await client.close()
  })
})
