import { fileExists, readFile, writeFile } from "@/commands/fs"
import { classifyHeadings, computeEntrySlugs } from "@/lib/heading-parser"
import { parseFrontmatter } from "@/lib/frontmatter"
import {
  appendWikilink,
  appendWikilinks,
  lintLinkTarget,
  mergeSubEntriesSection,
} from "@/lib/lint-fixes"
import { normalizePath } from "@/lib/path-utils"
import type { HeadingNode, SlugMode } from "@/types/ingest"

const SLUG_MODE_INFERENCE_ORDER: SlugMode[] = [
  "doc-h1-leaf",
  "doc-h1-h2-leaf",
  "title-concept",
  "full-hierarchy",
  "default",
  "manual",
]

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
  for (const folder of ["concepts", "entities", "sources"] as const) {
    const rel = `wiki/${folder}/${target}.md`
    if (await fileExists(`${pp}/${rel}`)) return rel
  }
  return null
}

async function resolveExistingLinkTargets(
  projectPath: string,
  slugs: string[],
  writtenPaths: string[],
): Promise<string[]> {
  const resolved: string[] = []
  const seen = new Set<string>()
  for (const rawSlug of slugs) {
    const slug = lintLinkTarget(rawSlug)
    if (!slug) continue
    const key = slug.toLowerCase()
    if (seen.has(key)) continue
    const path = await resolveWikiPathForSlug(projectPath, slug, writtenPaths)
    if (!path) continue
    seen.add(key)
    resolved.push(slug)
  }
  return resolved
}

async function hierarchyLinkTargetsForPage(
  projectPath: string,
  writtenPaths: string[],
  parsed: ReturnType<typeof parseFrontmatter>,
  entry: HeadingNode | undefined,
  entries: HeadingNode[],
  entrySlugs: Map<string, string>,
): Promise<string[]> {
  const candidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (value: unknown) => {
    const slug = frontmatterSlug(value)
    if (!slug) return
    const key = slug.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(slug)
  }

  if (entry) {
    const treeParent = parentSlugForEntry(entry, entries, entrySlugs)
    if (treeParent) addCandidate(treeParent)
  }
  addCandidate(parsed.frontmatter?.parent)
  addCandidate(parsed.frontmatter?.ancestor)

  return resolveExistingLinkTargets(projectPath, candidates, writtenPaths)
}

export function relatePageToTargets(content: string, targetSlugs: string[]): RelatePageResult {
  const next = appendWikilinks(content, targetSlugs)
  return { content: next, changed: next !== content }
}

export function buildEntrySlugMap(
  entries: HeadingNode[],
  slugMode: SlugMode,
  documentName: string,
  slugNamespace = "",
): Map<string, string> {
  return computeEntrySlugs(entries, slugMode, documentName, slugNamespace)
}

/** Pick the slug mode that best matches already-written wiki pages. */
export function inferSlugModeForEntries(
  entries: HeadingNode[],
  documentName: string,
  writtenPaths: string[],
  slugNamespace = "",
  preferredMode: SlugMode = "default",
): SlugMode {
  const wikiSlugs = new Set(
    writtenPaths
      .map((path) => slugFromWikiEntryPath(path))
      .filter((slug): slug is string => slug !== null)
      .map((slug) => slug.toLowerCase()),
  )
  if (wikiSlugs.size === 0 || entries.length === 0) return preferredMode

  const modes = preferredMode !== "default"
    ? [preferredMode, ...SLUG_MODE_INFERENCE_ORDER.filter((mode) => mode !== preferredMode)]
    : SLUG_MODE_INFERENCE_ORDER

  let best: { mode: SlugMode; score: number } = { mode: preferredMode, score: 0 }
  for (const mode of modes) {
    const slugs = computeEntrySlugs(entries, mode, documentName, slugNamespace)
    let score = 0
    for (const slug of slugs.values()) {
      if (wikiSlugs.has(slug.toLowerCase())) score++
    }
    if (score > best.score) best = { mode, score }
  }
  return best.score > 0 ? best.mode : preferredMode
}

function pathKeyFromHeadingPath(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const parts = value
    .map((part) => (typeof part === "string" ? part.trim().toLowerCase() : ""))
    .filter(Boolean)
  return parts.length > 0 ? parts.join(" > ") : null
}

function frontmatterSlug(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === "null" || trimmed === "None") return null
  return trimmed
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

      const original = await loadContent(relativePath)
      const parsed = parseFrontmatter(original)
      const pathKey = slugToPathKey.get(slug.toLowerCase())
        ?? pathKeyFromHeadingPath(parsed.frontmatter?.heading_path)
      const entry = pathKey
        ? entries.find((candidate) => candidate.pathKey === pathKey)
        : undefined

      const targets = await hierarchyLinkTargetsForPage(
        pp,
        opts.writtenPaths,
        parsed,
        entry,
        entries,
        entrySlugs,
      )
      if (targets.length > 0) {
        const related = relatePageToTargets(original, targets)
        if (related.changed) {
          parentLinksAdded += targets.length
          stageWrite(relativePath, related.content, original)
        }
      }
    }

    const childrenByParentSlug = new Map<string, string[]>()
    for (const relativePath of entryPaths) {
      const slug = slugFromWikiEntryPath(relativePath)
      if (!slug) continue
      const original = await loadContent(relativePath)
      const parentSlug = frontmatterSlug(parseFrontmatter(original).frontmatter?.parent)
      if (!parentSlug) continue
      const existing = childrenByParentSlug.get(parentSlug.toLowerCase()) ?? []
      existing.push(slug)
      childrenByParentSlug.set(parentSlug.toLowerCase(), existing)
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

    for (const [parentSlugKey, childSlugs] of childrenByParentSlug) {
      const parentRelPath = pathBySlug.get(parentSlugKey)
        ?? await resolveWikiPathForSlug(pp, parentSlugKey, opts.writtenPaths)
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
