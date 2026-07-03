import { describe, it, expect } from "vitest"
import {
  countBodyWikilinks,
  validateSourceSummaryHub,
  findUndesiredChapterPages,
} from "@/lib/ingest-validation"

describe("countBodyWikilinks", () => {
  it("counts wikilinks in body only", () => {
    const content = `---
title: Test
---
# Summary

See [[gaman]] and [[nodfri]] for details.
`
    expect(countBodyWikilinks(content)).toBe(2)
  })
})

describe("validateSourceSummaryHub", () => {
  it("passes when enough wikilinks", () => {
    const body = "# Hub\n\n[[a]] [[b]] [[c]]"
    expect(validateSourceSummaryHub(body).ok).toBe(true)
  })

  it("fails when too few wikilinks", () => {
    expect(validateSourceSummaryHub("# Hub\n\nNo links").ok).toBe(false)
  })
})

describe("findUndesiredChapterPages", () => {
  it("flags chapter-like paths", () => {
    const paths = [
      "wiki/entities/gaman.md",
      "wiki/concepts/capitolo-1.md",
      "wiki/entities/chapter-2.md",
    ]
    expect(findUndesiredChapterPages(paths)).toEqual([
      "wiki/concepts/capitolo-1.md",
      "wiki/entities/chapter-2.md",
    ])
  })

  it("does not flag legit slugs that merely start with a chapter word", () => {
    const paths = [
      "wiki/concepts/part-of-the-whole.md",
      "wiki/entities/chapterhouse.md",
      "wiki/concepts/parte-civile.md",
    ]
    expect(findUndesiredChapterPages(paths)).toEqual([])
  })

  it("flags roman-numeral chapter pages", () => {
    const paths = ["wiki/concepts/capitolo-iv.md"]
    expect(findUndesiredChapterPages(paths)).toEqual(["wiki/concepts/capitolo-iv.md"])
  })
})
