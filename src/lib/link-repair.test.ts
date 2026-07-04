import { describe, expect, it } from "vitest"
import { appendWikilink, hasWikilinkToTarget } from "@/lib/lint-fixes"
import { parseFrontmatterArray, writeFrontmatterArray } from "@/lib/sources-merge"

describe("link-repair custom relate logic", () => {
  const pageContent = [
    "---",
    "type: concept",
    'title: "Rituali"',
    "ingest_strategy: encyclopedia",
    'sources: ["compendio-nani.md"]',
    "related: []",
    "---",
    "",
    "# Rituali",
    "",
    "Body text.",
    "",
  ].join("\n")

  it("appends wikilink and related frontmatter for custom target", () => {
    const target = "compendio-dei-nani-delle-montagne"
    let next = appendWikilink(pageContent, target)
    const related = parseFrontmatterArray(next, "related")
    next = writeFrontmatterArray(next, "related", [...related, target])

    expect(hasWikilinkToTarget(next, target)).toBe(true)
    expect(parseFrontmatterArray(next, "related")).toContain(target)
  })

  it("skips when wikilink already present", () => {
    const linked = appendWikilink(pageContent, "existing-hub")
    const next = appendWikilink(linked, "existing-hub")
    expect(next).toBe(linked)
  })
})
