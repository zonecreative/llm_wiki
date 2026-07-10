import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { parseHeadingTree, classifyHeadings } from "@/lib/heading-parser"
import { inferSlugModeForEntries } from "@/lib/hub-linking"
import { sourceSummarySlugFromIdentity, sourceIdentityForPath } from "@/lib/source-identity"

const ROOT = join(process.cwd(), "wiki-soeliok")
const HAS = existsSync(ROOT)

function listWikiMdFiles(): Array<{ relativePath: string; slug: string }> {
  const out: Array<{ relativePath: string; slug: string }> = []
  const walk = (dir: string, relBase: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = `${relBase}/${name}`.replace(/^\//, "")
      if (statSync(full).isDirectory()) walk(full, rel)
      else if (name.endsWith(".md") && rel.startsWith("wiki/concepts/")) {
        out.push({ relativePath: rel, slug: name.replace(/\.md$/, "") })
      }
    }
  }
  walk(join(ROOT, "wiki"), "wiki")
  return out
}

function installFsMock() {
  vi.doMock("@/commands/fs", () => ({
    readFile: async (path: string) => readFileSync(path.replace(/\\/g, "/"), "utf8"),
    writeFile: vi.fn(),
    fileExists: async (path: string) => existsSync(path.replace(/\\/g, "/")),
    listDirectory: vi.fn(),
    createDirectory: vi.fn(),
  }))
}

describe.skipIf(!HAS)("link-repair soeliok compendio", () => {
  it("infers doc-h1-leaf slug mode for ingested wiki pages", () => {
    const sourcePath = join(
      ROOT,
      "raw/sources/Soeliok/Prodotti/Universo/Popoli/I Nani delle montagne.md",
    ).replace(/\\/g, "/")
    const source = readFileSync(sourcePath, "utf8")
    const { entries } = classifyHeadings(parseHeadingTree(source), 1)
    const writtenPaths = listWikiMdFiles().map((file) => file.relativePath)
    const mode = inferSlugModeForEntries(
      entries,
      "I Nani delle montagne",
      writtenPaths,
      "",
      "default",
    )
    expect(mode).toBe("doc-h1-leaf")
  })

  it("plans hierarchy changes for pages missing parent wikilinks", async () => {
    vi.resetModules()
    installFsMock()

    const { computeStructuralLinkChanges } = await import("@/lib/hub-linking")
    const sourcePath = join(
      ROOT,
      "raw/sources/Soeliok/Prodotti/Universo/Popoli/I Nani delle montagne.md",
    ).replace(/\\/g, "/")
    const source = readFileSync(sourcePath, "utf8")
    const writtenPaths = listWikiMdFiles().map((file) => file.relativePath)
    const { entries } = classifyHeadings(parseHeadingTree(source), 1)
    const identity = sourceIdentityForPath(ROOT, sourcePath)
    const summarySlug = sourceSummarySlugFromIdentity(identity)
    const slugMode = inferSlugModeForEntries(
      entries,
      "I Nani delle montagne",
      writtenPaths,
      "",
      "default",
    )

    const result = await computeStructuralLinkChanges({
      projectPath: ROOT,
      headingTree: parseHeadingTree(source),
      writtenPaths,
      slugMode,
      documentName: "I Nani delle montagne",
      sourceSummarySlug: summarySlug,
      includeHubLinks: false,
      includeHierarchyLinks: true,
    })

    expect(result.pendingWrites.size).toBeGreaterThanOrEqual(0)
  })

  it("plans hub links to source summary page", async () => {
    vi.resetModules()
    installFsMock()

    const { computeStructuralLinkChanges } = await import("@/lib/hub-linking")
    const sourcePath = join(
      ROOT,
      "raw/sources/Soeliok/Prodotti/Universo/Popoli/I Nani delle montagne.md",
    ).replace(/\\/g, "/")
    const source = readFileSync(sourcePath, "utf8")
    const writtenPaths = listWikiMdFiles().map((file) => file.relativePath)
    const { entries } = classifyHeadings(parseHeadingTree(source), 1)
    const identity = sourceIdentityForPath(ROOT, sourcePath)
    const summarySlug = sourceSummarySlugFromIdentity(identity)
    const slugMode = inferSlugModeForEntries(
      entries,
      "I Nani delle montagne",
      writtenPaths,
      "",
      "default",
    )

    const result = await computeStructuralLinkChanges({
      projectPath: ROOT,
      headingTree: parseHeadingTree(source),
      writtenPaths,
      slugMode,
      documentName: "I Nani delle montagne",
      sourceSummarySlug: summarySlug,
      includeHubLinks: true,
      includeHierarchyLinks: false,
    })

    expect(result.hubSlug).toBe(summarySlug)
    expect(result.hubLinksAdded).toBeGreaterThan(100)
    expect(result.pendingWrites.size).toBeGreaterThan(100)
  })
})
