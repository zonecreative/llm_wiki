import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const SOELIOK_ROOT = join(process.cwd(), "wiki-soeliok")
const HAS_SOELIOK = existsSync(SOELIOK_ROOT)

function buildTree(dir: string, projectRoot: string): FileNode[] {
  const nodes: FileNode[] = []
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name)
    const st = statSync(fullPath)
    const path = fullPath.replace(/\\/g, "/")
    if (st.isDirectory()) {
      const children = buildTree(fullPath, projectRoot)
      nodes.push({
        name,
        path,
        is_dir: true,
        children: children.length > 0 ? children : undefined,
      })
    } else if (name.endsWith(".md")) {
      nodes.push({ name, path, is_dir: false })
    }
  }
  return nodes
}

function installSoeliokFsMock() {
  vi.doMock("@/commands/fs", () => ({
    readFile: async (path: string) => readFileSync(path, "utf8"),
    listDirectory: async (path: string) => {
      const normalized = path.replace(/\\/g, "/")
      if (normalized.endsWith("/wiki")) {
        return buildTree(join(SOELIOK_ROOT, "wiki"), SOELIOK_ROOT)
      }
      return []
    },
    writeFile: vi.fn(),
    createDirectory: vi.fn(),
  }))
}

describe.skipIf(!HAS_SOELIOK)("link-repair — wiki-soeliok compendio", () => {
  it("finds encyclopedia pages even when wiki paths use a different absolute prefix", async () => {
    vi.resetModules()
    installSoeliokFsMock()

    const { findEncyclopediaPagesForSource: findPages } = await import("@/lib/link-repair")
    const sourcePath = join(
      SOELIOK_ROOT,
      "raw/sources/Soeliok/Prodotti/Universo/Popoli/I Nani delle montagne.md",
    ).replace(/\\/g, "/")

    const pages = await findPages("/Users/me/wiki-soeliok", sourcePath)
    expect(pages.length).toBeGreaterThan(50)
  })

  it("searches wiki pages by partial slug/title", async () => {
    vi.resetModules()
    installSoeliokFsMock()

    const { searchWikiPages: searchPages } = await import("@/lib/link-repair")
    const results = await searchPages("/Users/me/wiki-soeliok", "nani montagne biologia")
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((item) => item.slug.includes("nani-delle-montagne"))).toBe(true)
  })
})
