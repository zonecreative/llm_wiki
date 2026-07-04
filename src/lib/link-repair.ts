import { createDirectory, listDirectory, readFile, writeFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import {
  computeStructuralLinkChanges,
  isEncyclopediaEntryWikiPath,
  slugFromWikiEntryPath,
} from "@/lib/hub-linking"
import { parseHeadingTree } from "@/lib/heading-parser"
import { appendWikilink, hasWikilinkToTarget, lintLinkTarget } from "@/lib/lint-fixes"
import { getFileName, normalizePath } from "@/lib/path-utils"
import {
  parseFrontmatterArray,
  parseSources,
  writeFrontmatterArray,
} from "@/lib/sources-merge"
import {
  sourceIdentityForPath,
  sourceReferenceIdentity,
  sourceSummarySlugFromIdentity,
} from "@/lib/source-identity"
import type { FileNode } from "@/types/wiki"
import type { SlugMode } from "@/types/ingest"

export type LinkRepairMode = "hub" | "hierarchy" | "custom"

export interface EncyclopediaWikiPage {
  relativePath: string
  slug: string
  title: string
  content: string
}

export interface LinkRepairPlanItem {
  relativePath: string
  pageTitle: string
  action: string
  targetSlug: string
  alreadyLinked: boolean
  selected: boolean
  newContent?: string
}

export interface LinkRepairPlan {
  mode: LinkRepairMode
  items: LinkRepairPlanItem[]
  pagesToModify: number
  hubSlug: string | null
  previewLines: string[]
}

export interface ApplyLinkRepairResult {
  modified: number
  skipped: number
  backupDir: string
}

function flattenMd(nodes: readonly FileNode[]): FileNode[] {
  const out: FileNode[] = []
  const walk = (items: readonly FileNode[]) => {
    for (const item of items) {
      if (item.is_dir && item.children) {
        walk(item.children)
      } else if (item.name.endsWith(".md")) {
        out.push(item)
      }
    }
  }
  walk(nodes)
  return out
}

function sourceMatchesIdentity(
  source: string,
  sourceIdentity: string,
  fileName: string,
): boolean {
  const ref = sourceReferenceIdentity(normalizePath(source)).toLowerCase()
  const identity = sourceReferenceIdentity(sourceIdentity).toLowerCase()
  if (ref === identity) return true
  if (!source.includes("/") && ref === fileName.toLowerCase()) return true
  return false
}

function isEncyclopediaPage(content: string): boolean {
  const parsed = parseFrontmatter(content)
  const strategy = parsed.frontmatter?.ingest_strategy
  if (strategy === "encyclopedia") return true
  if (strategy === undefined || strategy === null) return true
  return false
}

function wikiRelativePath(filePath: string, projectPath: string): string {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  const fp = normalizePath(filePath)
  if (fp.startsWith(`${pp}/`)) return fp.slice(pp.length + 1)
  return fp
}

export async function findEncyclopediaPagesForSource(
  projectPath: string,
  sourcePath: string,
): Promise<EncyclopediaWikiPage[]> {
  const pp = normalizePath(projectPath)
  const sourceIdentity = sourceIdentityForPath(pp, sourcePath)
  const fileName = getFileName(sourcePath)

  let wikiTree: FileNode[] = []
  try {
    wikiTree = await listDirectory(`${pp}/wiki`, true)
  } catch {
    return []
  }

  const pages: EncyclopediaWikiPage[] = []
  for (const file of flattenMd(wikiTree)) {
    const relativePath = wikiRelativePath(file.path, pp)
    if (!isEncyclopediaEntryWikiPath(relativePath)) continue

    let content: string
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }

    if (!isEncyclopediaPage(content)) continue

    const sources = parseSources(content)
    if (!sources.some((source) => sourceMatchesIdentity(source, sourceIdentity, fileName))) {
      continue
    }

    const slug = slugFromWikiEntryPath(relativePath)
    if (!slug) continue

    const parsed = parseFrontmatter(content)
    const title = typeof parsed.frontmatter?.title === "string"
      ? parsed.frontmatter.title
      : slug

    pages.push({ relativePath, slug, title, content })
  }

  pages.sort((a, b) => a.title.localeCompare(b.title))
  return pages
}

export async function searchWikiPages(
  projectPath: string,
  query: string,
  limit = 20,
): Promise<Array<{ slug: string; title: string; relativePath: string }>> {
  const pp = normalizePath(projectPath)
  const q = query.trim().toLowerCase()
  if (!q) return []

  let wikiTree: FileNode[] = []
  try {
    wikiTree = await listDirectory(`${pp}/wiki`, true)
  } catch {
    return []
  }

  const results: Array<{ slug: string; title: string; relativePath: string; score: number }> = []
  for (const file of flattenMd(wikiTree)) {
    const relativePath = wikiRelativePath(file.path, pp)
    if (!relativePath.startsWith("wiki/") || relativePath.endsWith("/index.md")) continue
    if (relativePath.endsWith("/log.md") || relativePath.endsWith("/overview.md")) continue

    let content: string
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }

    const parsed = parseFrontmatter(content)
    const title = typeof parsed.frontmatter?.title === "string"
      ? parsed.frontmatter.title
      : getFileName(relativePath).replace(/\.md$/, "")

    const slug = relativePath
      .replace(/^wiki\//, "")
      .replace(/\.md$/, "")

    const haystack = `${title} ${slug}`.toLowerCase()
    if (!haystack.includes(q)) continue

    const score = haystack.startsWith(q) ? 0 : haystack.indexOf(q)
    results.push({ slug: lintLinkTarget(slug), title, relativePath, score })
  }

  results.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title))
  return results.slice(0, limit).map(({ slug, title, relativePath }) => ({
    slug,
    title,
    relativePath,
  }))
}

function planItemFromWrite(
  relativePath: string,
  originalContent: string,
  newContent: string,
  action: string,
  targetSlug: string,
  selected: boolean,
): LinkRepairPlanItem {
  const parsed = parseFrontmatter(originalContent)
  const title = typeof parsed.frontmatter?.title === "string"
    ? parsed.frontmatter.title
    : slugFromWikiEntryPath(relativePath) ?? relativePath

  return {
    relativePath,
    pageTitle: title,
    action,
    targetSlug,
    alreadyLinked: false,
    selected,
    newContent,
  }
}

export async function planLinkRepair(options: {
  projectPath: string
  sourcePath: string
  mode: LinkRepairMode
  targetSlug?: string
  selectedPaths?: Set<string>
  slugMode?: SlugMode
  slugNamespace?: string
}): Promise<LinkRepairPlan> {
  const pp = normalizePath(options.projectPath)
  const pages = await findEncyclopediaPagesForSource(pp, options.sourcePath)
  const writtenPaths = pages.map((page) => page.relativePath)
  const selectedPaths = options.selectedPaths

  if (pages.length === 0) {
    return {
      mode: options.mode,
      items: [],
      pagesToModify: 0,
      hubSlug: null,
      previewLines: [],
    }
  }

  const sourceIdentity = sourceIdentityForPath(pp, options.sourcePath)
  const documentName = getFileName(options.sourcePath).replace(/\.[^/.]+$/, "")
  const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)

  const items: LinkRepairPlanItem[] = []

  if (options.mode === "hub" || options.mode === "hierarchy") {
    let sourceContent = ""
    try {
      sourceContent = await readFile(normalizePath(options.sourcePath))
    } catch {
      return {
        mode: options.mode,
        items: [],
        pagesToModify: 0,
        hubSlug: null,
        previewLines: [],
      }
    }

    const headingTree = parseHeadingTree(sourceContent)
    const structural = await computeStructuralLinkChanges({
      projectPath: pp,
      headingTree,
      writtenPaths,
      slugMode: options.slugMode ?? "default",
      documentName,
      slugNamespace: options.slugNamespace,
      sourceSummarySlug,
      includeHubLinks: options.mode === "hub",
      includeHierarchyLinks: options.mode === "hierarchy",
    })

    for (const page of pages) {
      const newContent = structural.pendingWrites.get(page.relativePath)
      if (!newContent || newContent === page.content) continue
      const isSelected = selectedPaths ? selectedPaths.has(page.relativePath) : true
      const action = options.mode === "hub" ? "hub-link" : "hierarchy"
      const target = options.mode === "hub"
        ? (structural.hubSlug ?? "")
        : "parent/sub-entries"
      items.push(planItemFromWrite(
        page.relativePath,
        page.content,
        newContent,
        action,
        target,
        isSelected,
      ))
    }

    const pagesToModify = items.filter((item) => item.selected && item.newContent).length
    const previewLines = items
      .filter((item) => item.selected && item.newContent)
      .slice(0, 10)
      .map((item) => `${item.pageTitle} → [[${item.targetSlug}]] (${item.action})`)

    return {
      mode: options.mode,
      items,
      pagesToModify,
      hubSlug: structural.hubSlug,
      previewLines,
    }
  }

  const targetSlug = lintLinkTarget(options.targetSlug ?? "")
  if (!targetSlug) {
    return {
      mode: options.mode,
      items: [],
      pagesToModify: 0,
      hubSlug: null,
      previewLines: [],
    }
  }

  for (const page of pages) {
    const isSelected = selectedPaths ? selectedPaths.has(page.relativePath) : true
    const alreadyLinked = hasWikilinkToTarget(page.content, targetSlug)
    if (alreadyLinked) {
      items.push({
        relativePath: page.relativePath,
        pageTitle: page.title,
        action: "custom-related",
        targetSlug,
        alreadyLinked: true,
        selected: isSelected,
      })
      continue
    }

    if (!isSelected) {
      items.push({
        relativePath: page.relativePath,
        pageTitle: page.title,
        action: "custom-related",
        targetSlug,
        alreadyLinked: false,
        selected: false,
      })
      continue
    }

    let newContent = appendWikilink(page.content, targetSlug)
    const related = parseFrontmatterArray(newContent, "related")
    const normalizedTarget = lintLinkTarget(targetSlug)
    if (!related.some((entry) => lintLinkTarget(entry).toLowerCase() === normalizedTarget.toLowerCase())) {
      newContent = writeFrontmatterArray(newContent, "related", [...related, normalizedTarget])
    }

    items.push(planItemFromWrite(
      page.relativePath,
      page.content,
      newContent,
      "custom-related",
      targetSlug,
      true,
    ))
  }

  const pagesToModify = items.filter((item) => item.selected && item.newContent).length
  const previewLines = items
    .filter((item) => item.selected && item.newContent)
    .slice(0, 10)
    .map((item) => `${item.pageTitle} → [[${item.targetSlug}]] (${item.action})`)

  return {
    mode: options.mode,
    items,
    pagesToModify,
    hubSlug: null,
    previewLines,
  }
}

export async function snapshotPageBackup(
  projectPath: string,
  pages: Array<{ relativePath: string; content: string }>,
): Promise<string> {
  const pp = normalizePath(projectPath)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupDir = `${pp}/.llm-wiki/page-history/link-repair-${stamp}`
  await createDirectory(backupDir)

  for (const page of pages) {
    const sanitized = page.relativePath.replace(/[/\\]/g, "_")
    await writeFile(`${backupDir}/${sanitized}`, page.content)
  }

  return backupDir
}

export async function applyLinkRepair(
  projectPath: string,
  plan: LinkRepairPlan,
  originalContents: Map<string, string>,
): Promise<ApplyLinkRepairResult> {
  const pp = normalizePath(projectPath)
  const toApply = plan.items.filter((item) => item.selected && item.newContent)

  const backupPages = toApply.map((item) => ({
    relativePath: item.relativePath,
    content: originalContents.get(item.relativePath) ?? "",
  }))
  const backupDir = await snapshotPageBackup(pp, backupPages)

  let modified = 0
  let skipped = 0
  for (const item of toApply) {
    if (!item.newContent) {
      skipped += 1
      continue
    }
    await writeFile(`${pp}/${item.relativePath}`, item.newContent)
    modified += 1
  }

  return { modified, skipped, backupDir }
}

export async function loadOriginalContentsForPlan(
  projectPath: string,
  plan: LinkRepairPlan,
): Promise<Map<string, string>> {
  const pp = normalizePath(projectPath)
  const originals = new Map<string, string>()
  for (const item of plan.items) {
    if (!item.selected || !item.newContent) continue
    if (originals.has(item.relativePath)) continue
    try {
      originals.set(item.relativePath, await readFile(`${pp}/${item.relativePath}`))
    } catch {
      originals.set(item.relativePath, "")
    }
  }
  return originals
}
