/**
 * Mixed ingest orchestrator — splits documents by H1 and classifies sections.
 */
import { heuristicClassify } from "@/lib/document-classifier"
import { classifyTableDocument } from "@/lib/table-structure-parser"
import type { IngestStrategy, SectionTypeEntry } from "@/types/ingest"

export interface DocumentSection {
  headingTitle: string
  headingLevel: number
  content: string
  lineStart: number
}

export interface MixedIngestPlan {
  sections: Array<DocumentSection & { strategy: Exclude<IngestStrategy, "mixed"> }>
  sectionMap: SectionTypeEntry[]
}

/** Split markdown body into H1 sections (first section may be pre-H1 intro). */
export function splitDocumentByH1(content: string): DocumentSection[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const sections: DocumentSection[] = []
  let current: DocumentSection | null = null
  let buffer: string[] = []

  const flush = () => {
    if (!current) return
    current.content = buffer.join("\n").trim()
    sections.push(current)
    buffer = []
    current = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const h1Match = line.match(/^#\s+(.+?)\s*$/)
    if (h1Match && !line.startsWith("##")) {
      flush()
      current = {
        headingTitle: h1Match[1].trim(),
        headingLevel: 1,
        content: "",
        lineStart: i,
      }
      continue
    }
    if (current) {
      buffer.push(line)
    } else if (line.trim()) {
      if (!current) {
        current = {
          headingTitle: "(intro)",
          headingLevel: 0,
          content: "",
          lineStart: 0,
        }
      }
      buffer.push(line)
    }
  }
  flush()

  if (sections.length === 0) {
    return [{
      headingTitle: "(document)",
      headingLevel: 0,
      content: content.trim(),
      lineStart: 0,
    }]
  }
  return sections
}

function classifySectionStrategy(
  section: DocumentSection,
): Exclude<IngestStrategy, "mixed"> {
  const tableInfo = classifyTableDocument(section.content)
  if (tableInfo.isTabular) return "tabular"

  const result = heuristicClassify(section.content)
  if (result.strategy === "mixed") return "fixed"
  return result.strategy
}

/** Build a per-section strategy map for mixed documents. */
export function buildMixedIngestPlan(content: string): MixedIngestPlan {
  const rawSections = splitDocumentByH1(content)
  const sections = rawSections.map((section) => ({
    ...section,
    strategy: classifySectionStrategy(section),
  }))

  const sectionMap: SectionTypeEntry[] = sections
    .filter((s) => s.headingLevel === 1)
    .map((s) => ({
      headingTitle: s.headingTitle,
      headingLevel: s.headingLevel,
      strategy: s.strategy,
    }))

  return { sections, sectionMap }
}

/** Serialize section map for cache/checkpoint keys. */
export function mixedSectionMapKey(sectionMap: SectionTypeEntry[]): string {
  return sectionMap
    .map((s) => `${s.headingTitle}:${s.strategy}`)
    .join("|")
}
