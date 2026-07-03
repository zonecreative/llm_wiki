import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import {
  detectMarkdownTables,
  parseMarkdownTableRows,
  classifyTableDocument,
  mapTipoToWikiType,
  formatTabularRowForPrompt,
  tabularColumnPreference,
} from "@/lib/table-structure-parser"
import { heuristicClassify } from "@/lib/document-classifier"
import { CLASSIFIER_CONFIDENCE_THRESHOLD } from "@/types/ingest"

const FIXTURES_DIR = join(__dirname, "..", "test-helpers", "fixtures", "ingest-strategy")
const FULL_INDICE = join(
  __dirname,
  "..",
  "..",
  "wiki-soeliok",
  "raw",
  "sources",
  "Soeliok",
  "Prodotti",
  "Narrativa",
  "Trilogia - Storie dalle Terre Popolate",
  "indice dei nomi.md",
)

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8")
}

describe("detectMarkdownTables — multi-row header", () => {
  const content = loadFixture("indice-nomi-table.md")

  it("detects one primary table block", () => {
    const blocks = detectMarkdownTables(content)
    expect(blocks.length).toBe(1)
    expect(blocks[0].dataRows.length).toBeGreaterThanOrEqual(10)
  })

  it("resolves ITA/ENG/tipo column headers", () => {
    const blocks = detectMarkdownTables(content)
    const headers = blocks[0].columnHeaders.map((h) => h.toLowerCase())
    expect(headers).toContain("ita")
    expect(headers).toContain("eng")
    expect(headers).toContain("tipo")
  })
})

describe("parseMarkdownTableRows", () => {
  const content = loadFixture("indice-nomi-table.md")

  it("parses primary names and slugs", () => {
    const rows = parseMarkdownTableRows(content)
    expect(rows.length).toBeGreaterThanOrEqual(10)
    const alithien = rows.find((r) => r.primaryName === "Alìthien")
    expect(alithien).toBeDefined()
    expect(alithien!.slug).toBeTruthy()
    expect(alithien!.tipo).toBe("luogo")
  })

  it("extracts multi-book descriptions", () => {
    const rows = parseMarkdownTableRows(content)
    const alithien = rows.find((r) => r.primaryName === "Alìthien")
    expect(alithien!.bookDescriptions.length).toBeGreaterThan(0)
  })

  it("detects vedi alias rows", () => {
    const full = readFileSync(FULL_INDICE, "utf-8")
    const rows = parseMarkdownTableRows(full)
    const bisonti = rows.find((r) => r.primaryName.includes("Bisonti"))
    expect(bisonti).toBeDefined()
    expect(bisonti!.aliasTarget?.toLowerCase()).toContain("yak")
  })
})

describe("classifyTableDocument", () => {
  it("classifies indice fixture as tabular", () => {
    const result = classifyTableDocument(loadFixture("indice-nomi-table.md"))
    expect(result.isTabular).toBe(true)
    expect(result.tableRowCount).toBeGreaterThanOrEqual(10)
  })

  it("does not classify compendio as tabular", () => {
    const result = classifyTableDocument(loadFixture("compendio-nani.md"))
    expect(result.isTabular).toBe(false)
  })

  it("does not classify romanzo as tabular", () => {
    const result = classifyTableDocument(loadFixture("romanzo-soeliok.md"))
    expect(result.isTabular).toBe(false)
  })
})

describe("formatTabularRowForPrompt — column preference", () => {
  const row = {
    rowIndex: 0,
    cells: {},
    raw: [],
    primaryName: "Askold",
    slug: "askold",
    tipo: "personaggio",
    tipoEng: "character",
    bookDescriptions: [
      { book: "libro 2", ita: "È un nano delle pianure.", eng: "A Plains Dwarf." },
    ],
  }

  it("prefers Italian columns when output language is Italian", () => {
    expect(tabularColumnPreference("Italian")).toBe("ita")
    const text = formatTabularRowForPrompt(row, "ita")
    expect(text).toContain("Tipo: personaggio")
    expect(text).not.toContain("Tipo ENG")
    expect(text).toContain("libro 2: È un nano delle pianure.")
    expect(text).not.toContain("ENG:")
  })

  it("falls back to English source with translate hint when ITA is empty", () => {
    const engOnly = {
      ...row,
      bookDescriptions: [{ book: "libro 1", ita: "", eng: "A Plains Dwarf." }],
    }
    const text = formatTabularRowForPrompt(engOnly, "ita")
    expect(text).toContain("[translate from source]: A Plains Dwarf.")
  })
})

describe("mapTipoToWikiType", () => {
  it("maps personaggio to entity", () => {
    expect(mapTipoToWikiType("personaggio", "character")).toBe("entity")
  })

  it("maps evento to concept", () => {
    expect(mapTipoToWikiType("evento", "event")).toBe("concept")
  })
})

describe("heuristicClassify — tabular regression", () => {
  it("classifies full indice as tabular with high confidence", () => {
    const content = readFileSync(FULL_INDICE, "utf-8")
    const result = heuristicClassify(content)
    expect(result.strategy).toBe("tabular")
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD)
  })

  it("keeps compendio as encyclopedia", () => {
    const result = heuristicClassify(loadFixture("compendio-nani.md"))
    expect(result.strategy).toBe("encyclopedia")
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD)
  })

  it("keeps romanzo as narrative", () => {
    const result = heuristicClassify(loadFixture("romanzo-soeliok.md"))
    expect(result.strategy).toBe("narrative")
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD)
  })
})
