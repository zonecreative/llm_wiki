import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

vi.mock("@/commands/fs", () => ({
  writeFile: vi.fn(),
  fileExists: async () => false,
}))
import {
  buildH1IndexPageContent,
  cleanHeadingTitle,
  collectChildSlugsForH1,
  extractH1Overview,
  listH1HeadingNodes,
  planH1IndexPages,
} from "@/lib/h1-index"
import { parseHeadingTree, classifyHeadings, computeEntrySlugs } from "@/lib/heading-parser"

const FIXTURE = `Intro al compendio.

# Biologia

Testo introduttivo del capitolo biologia.

## Anatomia

### Struttura fisica

#### Altezza

L'altezza varia.

#### Corporatura

Corpo robusto.

# Cultura

Intro cultura con abbastanza testo per superare la soglia minima del candidato capitolo.

### Rituali

Riti sacri.
`

describe("h1-index", () => {
  const tree = parseHeadingTree(FIXTURE)
  const h1s = listH1HeadingNodes(tree)

  it("lists H1 chapter nodes", () => {
    expect(h1s.map((node) => cleanHeadingTitle(node.title))).toEqual(["Biologia", "Cultura"])
  })

  it("extracts overview without child headings", () => {
    const biologia = h1s[0]
    expect(extractH1Overview(biologia.content)).toContain("introduttivo")
    expect(extractH1Overview(biologia.content)).not.toContain("Anatomia")
  })

  it("builds index page with sub-entries and hub link", () => {
    const content = buildH1IndexPageContent({
      title: "Biologia",
      slug: "compendio-biologia",
      overview: "Intro",
      childSlugs: ["compendio-biologia-altezza", "compendio-biologia-corporatura"],
      sourceIdentity: "compendio.md",
      sourceSummarySlug: "source-summary",
    })
    expect(content).toContain("h1_index: true")
    expect(content).toContain("heading_level: 1")
    expect(content).toContain("[[compendio-biologia-altezza]]")
    expect(content).toContain("[[source-summary]]")
  })

  it("collects child slugs under H1 from entries and wiki pages", () => {
    const classification = classifyHeadings(tree, 1)
    const entrySlugs = computeEntrySlugs(classification.entries, "doc-h1-leaf", "Compendio", "")
    const biologia = h1s[0]
    const biologiaSlug = "compendio-biologia"
    const wikiPages = new Map([
      ["compendio-biologia-altezza", "---\nancestor: compendio-biologia\nheading_path: [Biologia, Anatomia, Struttura fisica, Altezza]\n---\n"],
    ])
    const children = collectChildSlugsForH1(
      biologia,
      classification.entries,
      entrySlugs,
      wikiPages,
      biologiaSlug,
    )
    expect(children).toContain("compendio-biologia-altezza")
  })

  it("plans missing H1 index pages", async () => {
    const plan = await planH1IndexPages({
      projectPath: "/tmp/project",
      headingTree: tree,
      writtenPaths: ["wiki/concepts/compendio-biologia-altezza.md"],
      slugMode: "doc-h1-leaf",
      documentName: "Compendio",
      sourceIdentity: "compendio.md",
      sourceSummarySlug: "source-summary",
      wikiPageContents: new Map([
        ["compendio-biologia-altezza", "---\nancestor: compendio-biologia\n---\n"],
      ]),
    })
    expect(plan).toHaveLength(2)
    expect(plan.every((item) => !item.exists)).toBe(true)
    const biologia = plan.find((item) => item.title === "Biologia")
    expect(biologia?.childSlugs.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!require("fs").existsSync(join(process.cwd(), "wiki-soeliok")))("h1-index soeliok", () => {
  it("plans H1 chapters for nani compendio", async () => {
    const { readFileSync: readFs } = await import("node:fs")
    const { vi } = await import("vitest")
    vi.doMock("@/commands/fs", async () => {
      const fs = await import("node:fs")
      return {
        readFile: async (path: string) => readFs(path, "utf8"),
        writeFile: vi.fn(),
        fileExists: async (path: string) => fs.existsSync(path),
        listDirectory: vi.fn(),
        createDirectory: vi.fn(),
      }
    })
    vi.resetModules()
    const { planH1IndexPages: planPages } = await import("@/lib/h1-index")
    const { parseHeadingTree: parseTree } = await import("@/lib/heading-parser")

    const source = readFileSync(
      join(process.cwd(), "wiki-soeliok/raw/sources/Soeliok/Prodotti/Universo/Popoli/I Nani delle montagne.md"),
      "utf8",
    )
    const conceptsDir = join(process.cwd(), "wiki-soeliok/wiki/concepts")
    const writtenPaths = require("fs").readdirSync(conceptsDir)
      .filter((name: string) => name.endsWith(".md"))
      .map((name: string) => `wiki/concepts/${name}`)
    const wikiPageContents = new Map<string, string>()
    for (const rel of writtenPaths.slice(0, 20)) {
      const slug = rel.replace(/^wiki\/concepts\//, "").replace(/\.md$/, "")
      wikiPageContents.set(slug, readFileSync(join(process.cwd(), "wiki-soeliok", rel), "utf8"))
    }

    const plan = await planPages({
      projectPath: join(process.cwd(), "wiki-soeliok"),
      headingTree: parseTree(source),
      writtenPaths,
      slugMode: "doc-h1-leaf",
      documentName: "I Nani delle montagne",
      sourceIdentity: "Soeliok/Prodotti/Universo/Popoli/I Nani delle montagne.md",
      sourceSummarySlug: "7-soeliok--8-prodotti--8-universo--6-popoli--21-i-nani-delle-montagne--14oj1b1",
      wikiPageContents,
    })
    expect(plan.length).toBeGreaterThanOrEqual(4)
    expect(plan.map((item) => item.title)).toContain("Biologia")
  })
})
