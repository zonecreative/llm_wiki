import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

vi.mock("@/lib/ingest-queue", () => ({
  enqueueBatch: vi.fn(async () => ["task-1"]),
}))

import { purgeWikiPagesForSources, forceReingestSource } from "@/lib/source-lifecycle"
import { enqueueBatch } from "@/lib/ingest-queue"

describe("purgeWikiPagesForSources", () => {
  let tmp: { path: string; cleanup: () => Promise<void> } | undefined

  beforeEach(async () => {
    tmp = await createTempProject("source-lifecycle-clean")
    await writeFileRaw(`${tmp.path}/raw/sources/indice.md`, "# Indice\n")
    await writeFileRaw(
      `${tmp.path}/wiki/entities/askold.md`,
      ["---", 'sources: ["indice.md"]', 'title: "Askold"', "---", "# Askold", "English body."].join("\n"),
    )
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/shared.md`,
      ["---", 'sources: ["indice.md", "other.md"]', 'title: "Shared"', "---", "# Shared"].join("\n"),
    )
    await writeFileRaw(`${tmp.path}/wiki/log.md`, "# Wiki Log\n")
  })

  afterEach(async () => {
    await tmp?.cleanup()
    tmp = undefined
  })

  it("deletes wiki pages that only reference the source", async () => {
    if (!tmp) throw new Error("missing temp project")

    const result = await purgeWikiPagesForSources(tmp.path, [`${tmp.path}/raw/sources/indice.md`])

    await expect(readFileRaw(`${tmp.path}/wiki/entities/askold.md`)).rejects.toThrow()
    await expect(readFileRaw(`${tmp.path}/wiki/concepts/shared.md`)).resolves.toContain(
      'sources: ["other.md"]',
    )
    expect(result.deletedWikiPaths.length).toBe(1)
    expect(result.rewrittenSourcePages).toBe(1)
  })
})

describe("forceReingestSource clean", () => {
  it("purges wiki pages before enqueueing when clean is true", async () => {
    const enqueueBatchMock = vi.mocked(enqueueBatch)
    enqueueBatchMock.mockClear()

    const tmp = await createTempProject("source-lifecycle-clean-force")
    try {
      await writeFileRaw(`${tmp.path}/raw/sources/indice.md`, "# Indice\n")
      await writeFileRaw(
        `${tmp.path}/wiki/entities/askold.md`,
        ["---", 'sources: ["indice.md"]', 'title: "Askold"', "---", "# Askold"].join("\n"),
      )

      await forceReingestSource(
        { id: "p1", name: "Project", path: tmp.path },
        [`${tmp.path}/raw/sources/indice.md`],
        { provider: "openai", model: "gpt-4", apiKey: "test", maxContextSize: 128000, ollamaUrl: "", customEndpoint: "" },
        { clean: true },
      )

      await expect(readFileRaw(`${tmp.path}/wiki/entities/askold.md`)).rejects.toThrow()
      expect(enqueueBatchMock).toHaveBeenCalled()
    } finally {
      await tmp.cleanup()
    }
  })
})
