import { describe, expect, jest, test } from "@jest/globals"
import { StackOverflowServer } from "../server.js"
import { internals } from "./helpers/serverInternals.js"

describe("Tool input validation", () => {
  test("rejects invalid search_by_error inputs before calling the API", async () => {
    const server = new StackOverflowServer()
    const searchSpy = jest
      .spyOn(internals(server), "searchStackOverflow")
      .mockResolvedValue({ results: [], page: 1, hasMore: false })

    const result = await internals(server).handleSearchByError({
      errorMessage: "TypeError: boom",
      limit: -1,
      responseFormat: "yaml",
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Validation failed")
    expect(searchSpy).not.toHaveBeenCalled()
  })
})
