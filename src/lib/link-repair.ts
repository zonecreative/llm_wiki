import { createDirectory, listDirectory, readFile, writeFile } from "@/commands/fs"
import { planH1IndexPages } from "@/lib/h1-index"
import { parseFrontmatter } from "@/lib/frontmatter"
import {
  computeStructuralLinkChanges,
  inferSlugModeForEntries,
  isEncyclopediaEntryWikiPath,
  slugFromWikiEntryPath,
} from "@/lib/hub-linking"
import { classifyHeadings, parseHeadingTree } from "@/lib/heading-parser"
import { appendWikilink, hasWikilinkToTarget, lintLinkTarget } from "@/lib/lint-fixes"
import { getFileName, normalizePath, projectRelativePath, resolveAbsoluteSourcePath } from "@/lib/path-utils"
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

export type LinkRepairMode = "hub" | "hierarchy" | "h1-index" | "custom"

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
  skipReason?: "missing-parent-page" | "already-linked" | "h1-exists"
}

export interface LinkRepairPlan {
  mode: LinkRepairMode
  items: LinkRepairPlanItem[]
  pagesToModify: number
  hubSlug: string | null
  previewLines: string[]
  resolvedSlugMode?: SlugMode
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

function normalizeSourceKey(value: string): string {
  return sourceReferenceIdentity(normalizePath(value)).toLowerCase()
}

function sourceMatchesIdentity(
  source: string,
  sourceIdentity: string,
  fileName: string,
): boolean {
  const ref = normalizeSourceKey(source)
  const identity = normalizeSourceKey(sourceIdentity)
  if (ref === identity) return true

  const refBase = getFileName(ref).toLowerCase()
  const identityBase = getFileName(identity).toLowerCase()
  if (refBase.length > 0 && refBase === identityBase) return true

  if (ref.endsWith(`/${identity}`) || identity.endsWith(`/${ref}`)) return true
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

function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
}

function searchTokens(query: string): string[] {
  return foldForSearch(query)
    .split(/[\s/._-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
}

function matchesSearchQuery(haystack: string, query: string): boolean {
  const foldedHaystack = foldForSearch(haystack)
  const foldedQuery = foldForSearch(query.trim())
  if (!foldedQuery) return false
  if (foldedHaystack.includes(foldedQuery)) return true

  const tokens = searchTokens(query)
  if (tokens.length === 0) return foldedHaystack.includes(foldedQuery)
  return tokens.every((token) => foldedHaystack.includes(token))
}

export async function findEncyclopediaPagesForSource(
  projectPath: string,
  sourcePath: string,
): Promise<EncyclopediaWikiPage[]> {
  const pp = normalizePath(projectPath)
  const absoluteSourcePath = resolveAbsoluteSourcePath(pp, sourcePath)
  const sourceIdentity = sourceIdentityForPath(pp, absoluteSourcePath)
  const fileName = getFileName(absoluteSourcePath)

  let wikiTree: FileNode[] = []
  try {
    wikiTree = await listDirectory(`${pp}/wiki`, true)
  } catch {
    return []
  }

  const pages: EncyclopediaWikiPage[] = []
  for (const file of flattenMd(wikiTree)) {
    const relativePath = projectRelativePath(file.path, pp)
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
    const relativePath = projectRelativePath(file.path, pp)
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

    const haystack = `${title} ${slug}`
    if (!matchesSearchQuery(haystack, q)) continue

    const foldedHaystack = foldForSearch(haystack)
    const foldedQuery = foldForSearch(q)
    const score = foldedHaystack.startsWith(foldedQuery)
      ? 0
      : foldedHaystack.indexOf(foldedQuery)
    results.push({ slug: lintLinkTarget(slug), title, relativePath, score })
  }

  results.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title))
  return results.slice(0, limit).map(({ slug, title, relativePath }) => ({
    slug,
    title,
    relativePath,
  }))
}

function addedRelatedTargets(originalContent: string, newContent: string): string[] {
  const extract = (content: string) => new Set(
    Array.from(content.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g))
      .map((match) => lintLinkTarget(match[1]).toLowerCase()),
  )
  const before = extract(originalContent)
  const after = extract(newContent)
  const added: string[] = []
  for (const target of after) {
    if (!before.has(target)) added.push(target)
  }
  return added
}

function hierarchySkipReason(content: string): LinkRepairPlanItem["skipReason"] {
  const parsed = parseFrontmatter(content)
  const parent = typeof parsed.frontmatter?.parent === "string"
    ? parsed.frontmatter.parent.trim()
    : ""
  if (!parent || parent === "null") return undefined
  if (hasWikilinkToTarget(content, parent)) return "already-linked"
  return "missing-parent-page"
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
  const absoluteSourcePath = resolveAbsoluteSourcePath(pp, options.sourcePath)
  const pages = await findEncyclopediaPagesForSource(pp, absoluteSourcePath)
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

  const sourceIdentity = sourceIdentityForPath(pp, absoluteSourcePath)
  const documentName = getFileName(absoluteSourcePath).replace(/\.[^/.]+$/, "")
  const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)

  const items: LinkRepairPlanItem[] = []

  if (options.mode === "h1-index") {
    let sourceContent = ""
    try {
      sourceContent = await readFile(normalizePath(absoluteSourcePath))
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
    const requestedSlugMode = options.slugMode ?? "default"
    const { entries } = classifyHeadings(headingTree, 1)
    const resolvedSlugMode = inferSlugModeForEntries(
      entries,
      documentName,
      writtenPaths,
      options.slugNamespace ?? "",
      requestedSlugMode,
    )
    const wikiPageContents = new Map(pages.map((page) => [page.slug, page.content]))
    const h1Plan = await planH1IndexPages({
      projectPath: pp,
      headingTree,
      writtenPaths,
      slugMode: resolvedSlugMode,
      documentName,
      slugNamespace: options.slugNamespace,
      sourceIdentity,
      sourceSummarySlug,
      wikiPageContents,
    })

    for (const h1 of h1Plan) {
      const isSelected = selectedPaths ? selectedPaths.has(h1.relativePath) : !h1.exists
      if (!h1.exists) {
        items.push({
          relativePath: h1.relativePath,
          pageTitle: h1.title,
          action: "create-h1-index",
          targetSlug: `${h1.childSlugs.length} sub-entries`,
          alreadyLinked: false,
          selected: isSelected,
          newContent: h1.content,
        })
        continue
      }
      items.push({
        relativePath: h1.relativePath,
        pageTitle: h1.title,
        action: "create-h1-index",
        targetSlug: h1.slug,
        alreadyLinked: true,
        selected: false,
        skipReason: "h1-exists",
      })
    }

    const pagesToModify = items.filter((item) => item.selected && item.newContent).length
    const previewLines = items
      .filter((item) => item.selected && item.newContent)
      .map((item) => `${item.pageTitle} (${item.targetSlug})`)

    return {
      mode: options.mode,
      items,
      pagesToModify,
      hubSlug: sourceSummarySlug,
      previewLines,
      resolvedSlugMode,
    }
  }

  if (options.mode === "hub" || options.mode === "hierarchy") {
    let sourceContent = ""
    try {
      sourceContent = await readFile(normalizePath(absoluteSourcePath))
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
    const requestedSlugMode = options.slugMode ?? "default"
    const { entries } = classifyHeadings(headingTree, 1)
    const resolvedSlugMode = inferSlugModeForEntries(
      entries,
      documentName,
      writtenPaths,
      options.slugNamespace ?? "",
      requestedSlugMode,
    )
    const structural = await computeStructuralLinkChanges({
      projectPath: pp,
      headingTree,
      writtenPaths,
      slugMode: resolvedSlugMode,
      documentName,
      slugNamespace: options.slugNamespace,
      sourceSummarySlug,
      includeHubLinks: options.mode === "hub",
      includeHierarchyLinks: options.mode === "hierarchy",
    })

    for (const page of pages) {
      const newContent = structural.pendingWrites.get(page.relativePath)
      const isSelected = selectedPaths ? selectedPaths.has(page.relativePath) : true
      const action = options.mode === "hub" ? "hub-link" : "hierarchy"
      const target = options.mode === "hub"
        ? (structural.hubSlug ?? "")
        : "parent/sub-entries"

      if (newContent && newContent !== page.content) {
        const addedTargets = options.mode === "hierarchy"
          ? addedRelatedTargets(page.content, newContent)
          : []
        const targetLabel = options.mode === "hub"
          ? (structural.hubSlug ?? "")
          : (addedTargets.length > 0 ? addedTargets.join(", ") : "parent/sub-entries")
        items.push(planItemFromWrite(
          page.relativePath,
          page.content,
          newContent,
          action,
          targetLabel,
          isSelected,
        ))
        continue
      }

      const parsed = parseFrontmatter(page.content)
      const title = typeof parsed.frontmatter?.title === "string"
        ? parsed.frontmatter.title
        : (slugFromWikiEntryPath(page.relativePath) ?? page.relativePath)
      const hubTarget = structural.hubSlug ?? ""
      const alreadyLinked = options.mode === "hub" && hubTarget
        ? hasWikilinkToTarget(page.content, hubTarget)
        : false
      const skipReason = options.mode === "hierarchy"
        ? hierarchySkipReason(page.content)
        : undefined

      items.push({
        relativePath: page.relativePath,
        pageTitle: title,
        action,
        targetSlug: target,
        alreadyLinked,
        selected: false,
        newContent: undefined,
        skipReason,
      })
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
      resolvedSlugMode,
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
