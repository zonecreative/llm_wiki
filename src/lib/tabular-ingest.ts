/**
 * Tabular ingest helpers — batch prompts and row formatting.
 */
import type { ParsedTableRow } from "@/lib/table-structure-parser"
import {
  formatTabularRowForPrompt,
  mapTipoToWikiType,
  tabularColumnPreference,
} from "@/lib/table-structure-parser"
import { buildLanguageDirective } from "@/lib/output-language"
import { GENERATION_WIKI_TYPES } from "@/lib/wiki-page-types"

export const TABULAR_BATCH_SIZE = 25

export function chunkTabularRows(
  rows: ParsedTableRow[],
  size: number = TABULAR_BATCH_SIZE,
): ParsedTableRow[][] {
  const batches: ParsedTableRow[][] = []
  for (let i = 0; i < rows.length; i += size) {
    batches.push(rows.slice(i, i + size))
  }
  return batches
}

/** True when a row is a pure alias/"vedi" cross-reference with no own content. */
function isAliasOnlyRow(row: ParsedTableRow): boolean {
  return Boolean(
    row.primaryName.trim() &&
      row.aliasTarget &&
      row.bookDescriptions.length === 0 &&
      !row.tipo &&
      !row.tipoEng,
  )
}

/** Rows that should generate wiki pages (skip pure alias/vedi rows). */
export function filterGeneratableTabularRows(rows: ParsedTableRow[]): ParsedTableRow[] {
  return rows.filter((row) => {
    if (!row.primaryName.trim()) return false
    if (isAliasOnlyRow(row)) return false
    return true
  })
}

/** Pure alias/"vedi" rows — surfaced as review items so cross-refs aren't lost. */
export function collectAliasOnlyRows(rows: ParsedTableRow[]): ParsedTableRow[] {
  return rows.filter(isAliasOnlyRow)
}

/**
 * Deterministic REVIEW block for an alias row. Keeps the "vedi X" link
 * discoverable in the review queue instead of dropping it silently.
 */
export function buildAliasReviewBlock(row: ParsedTableRow): string {
  const target = row.aliasTarget ?? ""
  return [
    `---REVIEW: duplicate | ${row.primaryName} → ${target}---`,
    `Alias entry from glossary: **${row.primaryName}** is a "vedi/see" cross-reference to **${target}**.`,
    "OPTIONS: Create redirect | Skip",
    "---END REVIEW---",
  ].join("\n")
}

export function buildTabularBatchSystemPrompt(params: {
  sourceIdentity: string
  sourceSummaryPath?: string
  schema: string
  purpose: string
  index: string
  allSlugs: string[]
  sourceContent?: string
  outputLanguage?: string
}): string {
  const {
    sourceIdentity,
    sourceSummaryPath,
    schema,
    purpose,
    index,
    allSlugs,
    sourceContent = "",
    outputLanguage = "",
  } = params
  const slugSample = allSlugs.slice(0, 30).join(", ")
  const columnPref = tabularColumnPreference(outputLanguage)

  return [
    "You are a wiki page generator for a glossary/table ingest.",
    "Do not output chain-of-thought or preamble.",
    "",
    buildLanguageDirective(sourceContent),
    "",
    "## Tabular Ingest Rules",
    "- Each row below is one glossary entry — create exactly one FILE block per row.",
    "- Use the PRE-COMPUTED slug exactly for the file path.",
    "- Map wiki type from the row: entity → wiki/entities/, concept → wiki/concepts/.",
    "- Consolidate multi-book descriptions (libro 1/2/3) into ONE page body.",
    "- Do NOT create separate pages per book column.",
    "- If a row has alias/vedi, emit a REVIEW block instead of a duplicate page.",
    "- Include `ingest_strategy: tabular` in frontmatter.",
    "- When source row text is in a different language than the mandatory output language, translate descriptive prose into the output language. Preserve proper nouns and established names.",
    columnPref === "ita"
      ? "- Prefer Italian source columns when present; translate any fallback English source text."
      : columnPref === "eng"
        ? "- Prefer English source columns when present; translate any fallback Italian source text."
        : "- Source may include parallel ITA/ENG columns — synthesize one page in the mandatory output language.",
    "",
    `Source file: **${sourceIdentity}**`,
    sourceSummaryPath ? `Source summary path: ${sourceSummaryPath}` : "",
    "",
    `Allowed types: ${GENERATION_WIKI_TYPES.join(" | ")}`,
    "",
    purpose ? `## Project Purpose\n${purpose}` : "",
    index ? `## Wiki Index\n${index}` : "",
    schema ? `## Schema\n${schema}` : "",
    "",
    `All entry slugs in this document (${allSlugs.length}): ${slugSample}${allSlugs.length > 30 ? ", ..." : ""}`,
    "",
    "## FILE block format",
    "---FILE: wiki/{entities|concepts}/<slug>.md---",
    "Frontmatter + body with [[wikilink]] where relevant.",
    "---END FILE---",
  ].filter(Boolean).join("\n")
}

export function buildTabularAggregateSystemPrompt(params: {
  sourceIdentity: string
  sourceSummaryPath: string
  entryCount: number
  topSlugs: string[]
  sourceContent?: string
}): string {
  const { sourceIdentity, sourceSummaryPath, entryCount, topSlugs, sourceContent = "" } = params
  return [
    "Generate aggregate wiki files for a tabular glossary ingest.",
    "Output ONLY FILE blocks for: source summary, index update, overview update, log entry.",
    "",
    buildLanguageDirective(sourceContent),
    "",
    `Source: ${sourceIdentity}`,
    `Source summary path: ${sourceSummaryPath}`,
    `Total glossary entries: ${entryCount}`,
    "",
    "## Source Summary Hub (CRITICAL)",
    "The source summary body MUST contain at least 8 [[wikilink]] to major entries.",
    "Do NOT rely only on frontmatter `related:` — wikilinks must appear in the body.",
    "",
    "Major entries to link:",
    topSlugs.map((s) => `- [[${s}]]`).join("\n"),
  ].join("\n")
}

export function buildTabularBatchUserMessage(
  batch: ParsedTableRow[],
  analysis: string,
  outputLanguage: string = "",
): string {
  const columnPref = tabularColumnPreference(outputLanguage)
  const rowsText = batch.map((row) => formatTabularRowForPrompt(row, columnPref)).join("\n\n")
  return [
    "Create FILE blocks for each row below.",
    "Write all page body prose in the mandatory output language from the system prompt.",
    "",
    "## Rows",
    rowsText,
    "",
    "## Stage 1 Analysis (context only)",
    analysis.slice(0, 8000),
  ].join("\n")
}

export function inferTabularPagePath(row: ParsedTableRow): string {
  const wikiType = mapTipoToWikiType(row.tipo, row.tipoEng)
  const dir = wikiType === "concept" ? "concepts" : "entities"
  return `wiki/${dir}/${row.slug}.md`
}
