import { describe, it, expect } from "vitest"
import type { ParsedTableRow } from "@/lib/table-structure-parser"
import {
  chunkTabularRows,
  filterGeneratableTabularRows,
  collectAliasOnlyRows,
  buildAliasReviewBlock,
  buildTabularBatchSystemPrompt,
  TABULAR_BATCH_SIZE,
} from "@/lib/tabular-ingest"
import { useWikiStore } from "@/stores/wiki-store"

// Minimal row factory for the fields these helpers care about.
function makeRow(overrides: Partial<ParsedTableRow>): ParsedTableRow {
  return {
    rowIndex: 0,
    cells: {},
    raw: [],
    primaryName: "Name",
    slug: "name",
    tipo: undefined,
    tipoEng: undefined,
    aliasTarget: undefined,
    bookDescriptions: [],
    ...overrides,
  }
}

describe("tabular-ingest row filtering", () => {
  it("keeps rows with content and drops pure alias rows", () => {
    const rows = [
      makeRow({ primaryName: "Kromak", tipo: "Personaggio" }),
      makeRow({ primaryName: "", slug: "" }),
      makeRow({ primaryName: "Scaglia", aliasTarget: "Scaglia di drago" }),
    ]
    const generatable = filterGeneratableTabularRows(rows)
    expect(generatable.map((r) => r.primaryName)).toEqual(["Kromak"])
  })

  it("keeps alias rows that also carry own content", () => {
    const rows = [
      makeRow({ primaryName: "Eira", aliasTarget: "Todar", tipo: "Personaggio" }),
    ]
    expect(filterGeneratableTabularRows(rows)).toHaveLength(1)
    expect(collectAliasOnlyRows(rows)).toHaveLength(0)
  })

  it("collects pure alias rows separately", () => {
    const rows = [
      makeRow({ primaryName: "Kromak", tipo: "Personaggio" }),
      makeRow({ primaryName: "Scaglia", aliasTarget: "Scaglia di drago" }),
    ]
    const aliases = collectAliasOnlyRows(rows)
    expect(aliases.map((r) => r.primaryName)).toEqual(["Scaglia"])
  })

  it("builds a parseable REVIEW block for an alias row", () => {
    const block = buildAliasReviewBlock(
      makeRow({ primaryName: "Scaglia", aliasTarget: "Scaglia di drago" }),
    )
    expect(block).toContain("---REVIEW: duplicate | Scaglia → Scaglia di drago---")
    expect(block).toContain("---END REVIEW---")
  })

  it("chunks rows using the shared batch size", () => {
    const rows = Array.from({ length: TABULAR_BATCH_SIZE + 3 }, (_, i) =>
      makeRow({ primaryName: `n${i}`, slug: `n${i}`, tipo: "Personaggio" }),
    )
    const batches = chunkTabularRows(rows)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(TABULAR_BATCH_SIZE)
    expect(batches[1]).toHaveLength(3)
  })

  it("includes mandatory output language in tabular batch system prompt", () => {
    useWikiStore.getState().setOutputLanguage("Italian")
    const prompt = buildTabularBatchSystemPrompt({
      sourceIdentity: "indice.md",
      schema: "",
      purpose: "",
      index: "",
      allSlugs: ["askold"],
      sourceContent: "Contenuto italiano della sorgente.",
      outputLanguage: "Italian",
    })
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Italian")
    expect(prompt).toContain("translate descriptive prose")
    expect(prompt).toContain("Prefer Italian source columns")
    useWikiStore.getState().setOutputLanguage("auto")
  })
})
