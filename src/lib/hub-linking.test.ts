import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import {
  buildChildrenSlugMap,
  buildEntrySlugMap,
  findWikiPathForSlug,
  isEncyclopediaEntryWikiPath,
  parentSlugForEntry,
  relatePageToTarget,
  slugFromWikiEntryPath,
} from "@/lib/hub-linking"
import { mergeSubEntriesSection } from "@/lib/lint-fixes"
import { parseHeadingTree, classifyHeadings } from "@/lib/heading-parser"

const FIXTURES_DIR = join(__dirname, "..", "test-helpers", "fixtures", "ingest-strategy")

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8")
}

describe("hub-linking helpers", () => {
  const compendio = loadFixture("compendio-nani.md")
  const nodes = parseHeadingTree(compendio)
  const classification = classifyHeadings(nodes, 1)
  const entrySlugs = buildEntrySlugMap(classification.entries, "default", "compendio-nani", "")

  it("extracts slug from wiki entry path", () => {
    expect(slugFromWikiEntryPath("wiki/concepts/rituali.md")).toBe("rituali")
    expect(isEncyclopediaEntryWikiPath("wiki/sources/foo.md")).toBe(false)
  })

  it("findWikiPathForSlug matches written paths", () => {
    const paths = ["wiki/concepts/rituali.md", "wiki/concepts/cultura.md"]
    expect(findWikiPathForSlug("rituali", paths)).toBe("wiki/concepts/rituali.md")
    expect(findWikiPathForSlug("missing", paths)).toBeNull()
  })

  it("parentSlugForEntry resolves Cultura for Rituali", () => {
    const rituali = classification.entries.find((entry) => entry.title === "Rituali")
    expect(rituali).toBeDefined()
    const parentSlug = parentSlugForEntry(rituali!, classification.entries, entrySlugs)
    expect(parentSlug).toBe(entrySlugs.get(
      classification.entries.find((entry) => entry.title === "Cultura")!.pathKey,
    ))
  })

  it("buildChildrenSlugMap lists Rituali under Cultura", () => {
    const children = buildChildrenSlugMap(classification.entries, entrySlugs)
    const cultura = classification.entries.find((entry) => entry.title === "Cultura")!
    const ritualiSlug = entrySlugs.get(
      classification.entries.find((entry) => entry.title === "Rituali")!.pathKey,
    )
    expect(children.get(cultura.pathKey)).toContain(ritualiSlug)
  })

  it("relatePageToTarget is no-op when link exists", () => {
    const content = "---\ntitle: x\n---\n\n## Related\n- [[hub-slug]]\n"
    const result = relatePageToTarget(content, "hub-slug")
    expect(result.changed).toBe(false)
  })

  it("relatePageToTarget appends Related section", () => {
    const content = "---\ntitle: x\n---\n\nBody text.\n"
    const result = relatePageToTarget(content, "parent-slug")
    expect(result.changed).toBe(true)
    expect(result.content).toContain("## Related")
    expect(result.content).toContain("[[parent-slug]]")
  })

  it("mergeSubEntriesSection merges without duplicating existing child", () => {
    const content = "---\ntitle: x\n---\n\n## Sub-entries\n- [[child-a]]\n"
    const merged = mergeSubEntriesSection(content, ["child-a", "child-b"])
    expect(merged.match(/\[\[child-a\]\]/g)?.length).toBe(1)
    expect(merged).toContain("[[child-b]]")
  })
})
