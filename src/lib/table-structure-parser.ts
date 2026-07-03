/**
 * Markdown table detection and parsing for tabular ingest strategy.
 * Pure functions — no I/O.
 */
import { makeQuerySlug } from "@/lib/wiki-filename"

export const TABULAR_MIN_DATA_ROWS = 10
export const TABULAR_MIN_LINE_RATIO = 0.35

const COLUMN_HEADER_ALIASES = new Set([
  "nome", "name", "ita", "eng", "tipo", "type", "categoria", "category",
  "description", "descrizione", "termine", "term", "tipo eng", "type eng",
  "libro 1", "libro 2", "libro 3", "book 1", "book 2", "book 3",
])

const PRIMARY_NAME_HEADERS = new Set(["nome", "name", "ita", "termine", "term"])
const TYPE_HEADERS = new Set(["tipo", "type", "categoria", "category", "tipo eng", "type eng"])

const ENTITY_TIPO_PATTERNS = [
  /personagg/i, /character/i, /luogo/i, /place/i, /istituz/i, /institution/i,
  /oggett/i, /object/i, /lingua/i, /language/i, /animale/i, /animal/i,
  /razza/i, /race/i, /mezzo/i, /transport/i, /means of transport/i,
  /famiglia/i, /family/i, /titolo/i, /title/i,
]

const CONCEPT_TIPO_PATTERNS = [
  /evento/i, /event/i, /termine tecnico/i, /technical term/i,
  /concett/i, /concept/i, /fenomeno/i, /phenomenon/i,
]

export interface MarkdownTableBlock {
  startLine: number
  endLine: number
  headerRows: string[][]
  columnHeaders: string[]
  dataRows: string[][]
}

export interface ParsedTableRow {
  rowIndex: number
  cells: Record<string, string>
  raw: string[]
  primaryName: string
  slug: string
  tipo?: string
  tipoEng?: string
  aliasTarget?: string
  bookDescriptions: Array<{ book: string; ita: string; eng: string }>
}

export interface TableDocumentClassification {
  isTabular: boolean
  tableRowCount: number
  tableLineRatio: number
  semanticHeaderHits: number
  primaryTable?: MarkdownTableBlock
  reasoning: string[]
}

function parseTableLine(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|")) return []
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "")
  return inner.split("|").map((c) => c.trim())
}

function isSeparatorRow(cells: string[]): boolean {
  if (cells.length === 0) return false
  return cells.every((c) => c === "" || /^:?-{3,}:?$/.test(c))
}

function looksLikeColumnHeader(cells: string[]): boolean {
  const nonEmpty = cells.filter((c) => c.length > 0)
  if (nonEmpty.length < 2) return false
  const aliasHits = nonEmpty.filter((c) => COLUMN_HEADER_ALIASES.has(c.toLowerCase())).length
  if (aliasHits >= 2) return true
  return nonEmpty.length >= 3 && nonEmpty.every((c) => c.length < 40)
}

function resolveColumnHeaders(rows: string[][]): { headerRows: string[][]; columnHeaders: string[] } {
  const sepIdx = rows.findIndex((r) => isSeparatorRow(r))
  if (sepIdx < 0) {
    const headers = rows[0] ?? []
    return {
      headerRows: headers.length > 0 ? [headers] : [],
      columnHeaders: headers.map((h, i) => h || `col_${i}`),
    }
  }

  const headerRows: string[][] = []
  for (let i = 0; i < sepIdx; i++) headerRows.push(rows[i])

  const afterSep = rows[sepIdx + 1]
  if (afterSep && looksLikeColumnHeader(afterSep)) {
    return {
      headerRows: [...headerRows, afterSep],
      columnHeaders: afterSep.map((h, i) => h || `col_${i}`),
    }
  }

  const beforeSep = rows[sepIdx - 1]
  if (beforeSep) {
    return {
      headerRows,
      columnHeaders: beforeSep.map((h, i) => h || `col_${i}`),
    }
  }

  return { headerRows, columnHeaders: [] }
}

/** Remove markdown table lines so dialogue heuristics ignore cell quotes. */
export function stripMarkdownTableLines(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.trim().startsWith("|"))
    .join("\n")
}

/** Find contiguous markdown table blocks in content. */
export function detectMarkdownTables(content: string): MarkdownTableBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const blocks: MarkdownTableBlock[] = []
  let i = 0

  while (i < lines.length) {
    if (!lines[i].trim().startsWith("|")) {
      i++
      continue
    }

    const startLine = i
    const tableLines: string[] = []
    while (i < lines.length) {
      const trimmed = lines[i].trim()
      if (trimmed.startsWith("|")) {
        tableLines.push(trimmed)
        i++
        continue
      }
      // Continuation line inside a multiline table cell
      if (trimmed.length > 0 && tableLines.length > 0) {
        tableLines[tableLines.length - 1] += ` ${trimmed}`
        i++
        continue
      }
      break
    }

    const parsedRows = tableLines
      .map(parseTableLine)
      .filter((r) => r.length > 0)

    if (parsedRows.length < 2) continue

    const { headerRows, columnHeaders } = resolveColumnHeaders(parsedRows)
    const sepIdx = parsedRows.findIndex((r) => isSeparatorRow(r))
    const dataStart = sepIdx >= 0
      ? (looksLikeColumnHeader(parsedRows[sepIdx + 1] ?? []) ? sepIdx + 2 : sepIdx + 1)
      : 1

    const dataRows = parsedRows.slice(dataStart).filter((r) => !isSeparatorRow(r))

    blocks.push({
      startLine,
      endLine: i - 1,
      headerRows,
      columnHeaders,
      dataRows,
    })
  }

  return blocks
}

function findColumnIndex(headers: string[], candidates: Set<string>, fallback = 0): number {
  const idx = headers.findIndex((h) => candidates.has(h.toLowerCase()))
  return idx >= 0 ? idx : fallback
}

function extractAliasTarget(text: string): string | undefined {
  const trimmed = text.trim()
  const vediMatch = trimmed.match(/^vedi[,:]?\s+(.+?)\.?$/i)
  if (vediMatch) return vediMatch[1].replace(/^['"]|['"]$/g, "").trim()
  const seeMatch = trimmed.match(/^see[:\s]+['"]?(.+?)['"]?\.?$/i)
  if (seeMatch) return seeMatch[1].trim()
  return undefined
}

function pairBookColumns(
  headers: string[],
  groupHeaderRow?: string[],
): Array<{ book: string; itaIdx: number; engIdx: number }> {
  const pairs: Array<{ book: string; itaIdx: number; engIdx: number }> = []
  const lower = headers.map((h) => h.toLowerCase())

  if (groupHeaderRow && groupHeaderRow.length > 0) {
    let currentBook = ""
    for (let i = 0; i < Math.max(headers.length, groupHeaderRow.length); i++) {
      const g = (groupHeaderRow[i] ?? "").trim()
      const bookMatch = g.match(/^libro\s*(\d+)$/i) ?? g.match(/^book\s*(\d+)$/i)
      if (bookMatch) currentBook = `libro ${bookMatch[1]}`
      if (currentBook && lower[i] === "ita") {
        const engIdx = i + 1 < lower.length && lower[i + 1] === "eng" ? i + 1 : -1
        pairs.push({ book: currentBook, itaIdx: i, engIdx })
      }
    }
    if (pairs.length > 0) return pairs
  }

  for (let i = 0; i < headers.length; i++) {
    const h = lower[i]
    const bookMatch = h.match(/^libro\s*(\d+)$/) ?? h.match(/^book\s*(\d+)$/)
    if (!bookMatch) continue
    const book = `libro ${bookMatch[1]}`
    let engIdx = -1
    for (let j = i + 1; j < Math.min(i + 3, headers.length); j++) {
      if (lower[j] === "eng" || lower[j] === "en") {
        engIdx = j
        break
      }
    }
    pairs.push({ book, itaIdx: i, engIdx })
  }

  return pairs
}

/** Parse table rows into structured records with slugs and book descriptions. */
export function parseMarkdownTableRows(content: string): ParsedTableRow[] {
  const blocks = detectMarkdownTables(content)
  if (blocks.length === 0) return []

  const primary = blocks.reduce((a, b) =>
    b.dataRows.length > a.dataRows.length ? b : a,
  )

  const nameIdx = findColumnIndex(primary.columnHeaders, PRIMARY_NAME_HEADERS, 0)
  const tipoIdx = findColumnIndex(primary.columnHeaders, TYPE_HEADERS, -1)
  const tipoEngIdx = primary.columnHeaders.findIndex((h) =>
    h.toLowerCase() === "tipo eng" || h.toLowerCase() === "type eng",
  )
  const bookPairs = pairBookColumns(
    primary.columnHeaders,
    primary.headerRows[0],
  )

  const rows: ParsedTableRow[] = []

  for (let i = 0; i < primary.dataRows.length; i++) {
    const raw = primary.dataRows[i]
    const cells: Record<string, string> = {}
    for (let c = 0; c < primary.columnHeaders.length; c++) {
      const key = primary.columnHeaders[c] || `col_${c}`
      cells[key] = raw[c] ?? ""
    }

    const primaryName = (raw[nameIdx] ?? "").trim()
    if (!primaryName) continue

    const tipo = tipoIdx >= 0 ? (raw[tipoIdx] ?? "").trim() : undefined
    const tipoEng = tipoEngIdx >= 0 ? (raw[tipoEngIdx] ?? "").trim() : undefined

    let aliasTarget: string | undefined
    for (const cell of raw) {
      const alias = extractAliasTarget(cell)
      if (alias) {
        aliasTarget = alias
        break
      }
    }

    const bookDescriptions: ParsedTableRow["bookDescriptions"] = []
    for (const { book, itaIdx, engIdx } of bookPairs) {
      const ita = (raw[itaIdx] ?? "").trim()
      const eng = engIdx >= 0 ? (raw[engIdx] ?? "").trim() : ""
      if (ita || eng) bookDescriptions.push({ book, ita, eng })
    }

    rows.push({
      rowIndex: i,
      cells,
      raw,
      primaryName,
      slug: makeQuerySlug(primaryName),
      tipo,
      tipoEng,
      aliasTarget,
      bookDescriptions,
    })
  }

  return rows
}

/** Classify whether a document is dominated by a glossary-style table. */
export function classifyTableDocument(content: string): TableDocumentClassification {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0)
  const tableLines = nonEmptyLines.filter((l) => l.trim().startsWith("|"))
  const tableLineRatio = nonEmptyLines.length > 0 ? tableLines.length / nonEmptyLines.length : 0

  const blocks = detectMarkdownTables(content)
  const primary = blocks.length > 0
    ? blocks.reduce((a, b) => (b.dataRows.length > a.dataRows.length ? b : a))
    : undefined

  const tableRowCount = primary?.dataRows.length ?? 0
  const reasoning: string[] = []

  let semanticHeaderHits = 0
  if (primary) {
    for (const h of primary.columnHeaders) {
      if (COLUMN_HEADER_ALIASES.has(h.toLowerCase())) semanticHeaderHits++
    }
    reasoning.push(`${tableRowCount} data rows, ${semanticHeaderHits} semantic headers`)
    reasoning.push(`table line ratio ${(tableLineRatio * 100).toFixed(0)}%`)
  }

  const isTabular =
    tableRowCount >= TABULAR_MIN_DATA_ROWS &&
    tableLineRatio >= TABULAR_MIN_LINE_RATIO &&
    semanticHeaderHits >= 2

  if (isTabular) {
    reasoning.push("dominant glossary-style table detected")
  }

  return {
    isTabular,
    tableRowCount,
    tableLineRatio,
    semanticHeaderHits,
    primaryTable: primary,
    reasoning,
  }
}

/** Map glossary tipo column to wiki page type. */
export function mapTipoToWikiType(tipo?: string, tipoEng?: string): "entity" | "concept" {
  const combined = `${tipo ?? ""} ${tipoEng ?? ""}`.trim()
  if (!combined) return "entity"
  if (CONCEPT_TIPO_PATTERNS.some((re) => re.test(combined))) return "concept"
  if (ENTITY_TIPO_PATTERNS.some((re) => re.test(combined))) return "entity"
  return "entity"
}

/** Prefer ITA or ENG glossary columns based on configured output language. */
export type TabularColumnPreference = "ita" | "eng" | "both"

export function tabularColumnPreference(outputLanguage: string): TabularColumnPreference {
  if (!outputLanguage || outputLanguage === "auto") return "both"
  const lang = outputLanguage.toLowerCase()
  if (lang === "italian" || lang === "italiano") return "ita"
  if (lang === "english") return "eng"
  return "both"
}

/** Format a parsed row as structured text for LLM batch prompts. */
export function formatTabularRowForPrompt(
  row: ParsedTableRow,
  columnPref: TabularColumnPreference = "both",
): string {
  const wikiType = mapTipoToWikiType(row.tipo, row.tipoEng)
  const lines = [
    `### Row: ${row.primaryName}`,
    `Slug: ${row.slug}`,
    `Wiki type: ${wikiType}`,
  ]

  if (columnPref === "eng") {
    if (row.tipoEng) lines.push(`Type: ${row.tipoEng}`)
    else if (row.tipo) lines.push(`Type: ${row.tipo}`)
  } else {
    if (row.tipo) lines.push(`Tipo: ${row.tipo}`)
    else if (row.tipoEng) lines.push(`Tipo: ${row.tipoEng}`)
  }

  if (row.aliasTarget) lines.push(`Alias/vedi → ${row.aliasTarget}`)

  if (row.bookDescriptions.length > 0) {
    lines.push("", "Descriptions:")
    for (const { book, ita, eng } of row.bookDescriptions) {
      if (columnPref === "ita") {
        if (ita) lines.push(`- ${book}: ${ita}`)
        else if (eng) lines.push(`- ${book} [translate from source]: ${eng}`)
      } else if (columnPref === "eng") {
        if (eng) lines.push(`- ${book}: ${eng}`)
        else if (ita) lines.push(`- ${book} [translate from source]: ${ita}`)
      } else {
        if (ita) lines.push(`- ${book} ITA: ${ita}`)
        if (eng) lines.push(`- ${book} ENG: ${eng}`)
      }
    }
  }

  return lines.join("\n")
}
