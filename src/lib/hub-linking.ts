import { fileExists, readFile, writeFile } from "@/commands/fs"
import { classifyHeadings, computeEntrySlugs } from "@/lib/heading-parser"
import {
  appendWikilink,
  lintLinkTarget,
  mergeSubEntriesSection,
} from "@/lib/lint-fixes"
import { normalizePath } from "@/lib/path-utils"
import type { HeadingNode, SlugMode } from "@/types/ingest"

export interface RelatePageResult {
  content: string
  changed: boolean
}

export interface ApplyEncyclopediaStructuralLinksOptions {
  projectPath: string
  headingTree: HeadingNode[]
  writtenPaths: string[]
  slugMode: SlugMode
  documentName: string
  slugNamespace?: string
  sourceSummarySlug: string
  includeHubLinks?: boolean
  includeHierarchyLinks?: boolean
}

export interface StructuralLinksResult {
  modifiedPaths: string[]
  hubSlug: string | null
  parentLinksAdded: number
  subEntrySectionsUpdated: number
  hubLinksAdded: number
}

export function slugFromWikiEntryPath(relativePath: string): string | null {
  const normalized = normalizePath(relativePath)
  const match = normalized.match(/^wiki\/(?:concepts|entities)\/(.+)\.md$/i)
  return match ? match[1] : null
}

export function isEncyclopediaEntryWikiPath(relativePath: string): boolean {
  return slugFromWikiEntryPath(relativePath) !== null
}

function isStructuralSkipPath(relativePath: string): boolean {
  const name = relativePath.split("/").pop() ?? ""
  return name === "index.md" || name === "log.md" || name === "overview.md"
}

export function findWikiPathForSlug(
  slug: string,
  writtenPaths: string[],
): string | null {
  const target = lintLinkTarget(slug).toLowerCase()
  for (const path of writtenPaths) {
    const pathSlug = slugFromWikiEntryPath(path)
    if (pathSlug && pathSlug.toLowerCase() === target) return path
  }
  return null
}

export async function resolveWikiPathForSlug(
  projectPath: string,
  slug: string,
  writtenPaths: string[],
): Promise<string | null> {
  const fromWritten = findWikiPathForSlug(slug, writtenPaths)
  if (fromWritten) return fromWritten

  const pp = normalizePath(projectPath)
  const target = lintLinkTarget(slug)
  for (const folder of ["concepts", "entities"] as const) {
    const rel = `wiki/${folder}/${target}.md`
    if (await fileExists(`${pp}/${rel}`)) return rel
  }
  return null
}

export function buildEntrySlugMap(
  entries: HeadingNode[],
  slugMode: SlugMode,
  documentName: string,
  slugNamespace = "",
): Map<string, string> {
  return computeEntrySlugs(entries, slugMode, documentName, slugNamespace)
}

export function buildChildrenSlugMap(
  entries: HeadingNode[],
  entrySlugs: Map<string, string>,
): Map<string, string[]> {
  const entryByPathKey = new Map(entries.map((entry) => [entry.pathKey, entry]))
  const childrenMap = new Map<string, string[]>()

  for (const entry of entries) {
    if (entry.headingPath.length < 2) continue
    const parentKey = entry.headingPath.slice(0, -1).join(" > ").toLowerCase()
    const parentEntry = entryByPathKey.get(parentKey)
    if (!parentEntry) continue
    const childSlug = entrySlugs.get(entry.pathKey)
    if (!childSlug) continue
    const existing = childrenMap.get(parentEntry.pathKey) ?? []
    existing.push(childSlug)
    childrenMap.set(parentEntry.pathKey, existing)
  }

  return childrenMap
}

export function parentSlugForEntry(
  entry: HeadingNode,
  entries: HeadingNode[],
  entrySlugs: Map<string, string>,
): string | null {
  if (entry.headingPath.length < 2) return null
  const parentKey = entry.headingPath.slice(0, -1).join(" > ").toLowerCase()
  const parentEntry = entries.find((candidate) => candidate.pathKey === parentKey)
  if (!parentEntry) return null
  return entrySlugs.get(parentEntry.pathKey) ?? null
}

export async function resolveDocumentHubSlug(
  projectPath: string,
  entries: HeadingNode[],
  entrySlugs: Map<string, string>,
  sourceSummarySlug: string,
  writtenPaths: string[],
): Promise<string | null> {
  const h1Entries = entries.filter((entry) => entry.level === 1)
  for (const entry of h1Entries) {
    const slug = entrySlugs.get(entry.pathKey)
    if (!slug) continue
    const path = await resolveWikiPathForSlug(projectPath, slug, writtenPaths)
    if (path) return slug
  }

  const summaryPath = `wiki/sources/${sourceSummarySlug}.md`
  if (writtenPaths.some((path) => normalizePath(path) === summaryPath)) {
    return sourceSummarySlug
  }

  const pp = normalizePath(projectPath)
  if (await fileExists(`${pp}/${summaryPath}`)) {
    return sourceSummarySlug
  }

  return null
}

export function relatePageToTarget(content: string, targetSlug: string): RelatePageResult {
  const next = appendWikilink(content, targetSlug)
  return { content: next, changed: next !== content }
}

export async function computeStructuralLinkChanges(
  opts: ApplyEncyclopediaStructuralLinksOptions,
): Promise<{
  pendingWrites: Map<string, string>
  hubSlug: string | null
  parentLinksAdded: number
  subEntrySectionsUpdated: number
  hubLinksAdded: number
}> {
  const includeHub = opts.includeHubLinks !== false
  const includeHierarchy = opts.includeHierarchyLinks !== false
  const pp = normalizePath(opts.projectPath)
  const classification = classifyHeadings(opts.headingTree, 1)
  const entries = classification.entries
  if (entries.length === 0) {
    return {
      pendingWrites: new Map(),
      hubSlug: null,
      parentLinksAdded: 0,
      subEntrySectionsUpdated: 0,
      hubLinksAdded: 0,
    }
  }

  const entrySlugs = buildEntrySlugMap(
    entries,
    opts.slugMode,
    opts.documentName,
    opts.slugNamespace ?? "",
  )
  const childrenMap = buildChildrenSlugMap(entries, entrySlugs)
  const hubSlug = includeHub
    ? await resolveDocumentHubSlug(
        pp,
        entries,
        entrySlugs,
        opts.sourceSummarySlug,
        opts.writtenPaths,
      )
    : null

  const entryPaths = opts.writtenPaths.filter(
    (path) => isEncyclopediaEntryWikiPath(path) && !isStructuralSkipPath(path),
  )

  const slugToPathKey = new Map<string, string>()
  for (const [pathKey, slug] of entrySlugs) {
    slugToPathKey.set(slug.toLowerCase(), pathKey)
  }

  const pathBySlug = new Map<string, string>()
  for (const path of entryPaths) {
    const slug = slugFromWikiEntryPath(path)
    if (slug) pathBySlug.set(slug.toLowerCase(), path)
  }

  const pendingWrites = new Map<string, string>()
  let parentLinksAdded = 0
  let subEntrySectionsUpdated = 0
  let hubLinksAdded = 0

  const loadContent = async (relativePath: string): Promise<string> => {
    if (pendingWrites.has(relativePath)) {
      return pendingWrites.get(relativePath)!
    }
    return readFile(`${pp}/${relativePath}`)
  }

  const stageWrite = (relativePath: string, content: string, original: string) => {
    if (content !== original) {
      pendingWrites.set(relativePath, content)
    }
  }

  if (includeHierarchy) {
    for (const relativePath of entryPaths) {
      const slug = slugFromWikiEntryPath(relativePath)
      if (!slug) continue
      const pathKey = slugToPathKey.get(slug.toLowerCase())
      if (!pathKey) continue
      const entry = entries.find((candidate) => candidate.pathKey === pathKey)
      if (!entry) continue

      const original = await loadContent(relativePath)
      let content = original

      const parentSlug = parentSlugForEntry(entry, entries, entrySlugs)
      if (parentSlug) {
        const parentPath = await resolveWikiPathForSlug(pp, parentSlug, opts.writtenPaths)
        if (parentPath) {
          const related = relatePageToTarget(content, parentSlug)
          if (related.changed) {
            parentLinksAdded += 1
            content = related.content
          }
        }
      }

      stageWrite(relativePath, content, original)
    }

    for (const [parentPathKey, childSlugs] of childrenMap) {
      const parentSlug = entrySlugs.get(parentPathKey)
      if (!parentSlug) continue
      const parentRelPath = pathBySlug.get(parentSlug.toLowerCase())
        ?? await resolveWikiPathForSlug(pp, parentSlug, opts.writtenPaths)
      if (!parentRelPath) continue

      const validChildren = (
        await Promise.all(
          childSlugs.map(async (childSlug) => {
            const childPath = await resolveWikiPathForSlug(pp, childSlug, opts.writtenPaths)
            return childPath ? childSlug : null
          }),
        )
      ).filter((childSlug): childSlug is string => childSlug !== null)

      if (validChildren.length === 0) continue

      const original = await loadContent(parentRelPath)
      const merged = mergeSubEntriesSection(original, validChildren)
      if (merged !== original) {
        subEntrySectionsUpdated += 1
        stageWrite(parentRelPath, merged, original)
      }
    }
  }

  if (includeHub && hubSlug) {
    for (const relativePath of entryPaths) {
      const slug = slugFromWikiEntryPath(relativePath)
      if (!slug || slug.toLowerCase() === hubSlug.toLowerCase()) continue
      const hubPath = await resolveWikiPathForSlug(pp, hubSlug, opts.writtenPaths)
      if (!hubPath) continue

      const original = await loadContent(relativePath)
      const related = relatePageToTarget(original, hubSlug)
      if (related.changed) {
        hubLinksAdded += 1
        stageWrite(relativePath, related.content, original)
      }
    }
  }

  return {
    pendingWrites,
    hubSlug,
    parentLinksAdded,
    subEntrySectionsUpdated,
    hubLinksAdded,
  }
}

export async function applyEncyclopediaStructuralLinks(
  opts: ApplyEncyclopediaStructuralLinksOptions,
): Promise<StructuralLinksResult> {
  const pp = normalizePath(opts.projectPath)
  const {
    pendingWrites,
    hubSlug,
    parentLinksAdded,
    subEntrySectionsUpdated,
    hubLinksAdded,
  } = await computeStructuralLinkChanges({
    ...opts,
    includeHubLinks: opts.includeHubLinks !== false,
    includeHierarchyLinks: opts.includeHierarchyLinks !== false,
  })

  const modifiedPaths: string[] = []
  for (const [relativePath, content] of pendingWrites) {
    await writeFile(`${pp}/${relativePath}`, content)
    modifiedPaths.push(relativePath)
  }

  if (modifiedPaths.length > 0) {
    console.log(
      `[hub-linking] structural links applied: ${modifiedPaths.length} page(s), hub=${hubSlug ?? "none"}, parent=${parentLinksAdded}, sub-entries=${subEntrySectionsUpdated}, hub-links=${hubLinksAdded}`,
    )
  }

  return {
    modifiedPaths,
    hubSlug,
    parentLinksAdded,
    subEntrySectionsUpdated,
    hubLinksAdded,
  }
}
