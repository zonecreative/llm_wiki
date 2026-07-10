import { writeFile } from "@/commands/fs"
import {
  buildEntrySlugMap,
  resolveWikiPathForSlug,
} from "@/lib/hub-linking"
import { classifyHeadings, computeEncyclopediaSlug, parseHeadingTree } from "@/lib/heading-parser"
import { parseFrontmatter } from "@/lib/frontmatter"
import { lintLinkTarget, mergeSubEntriesSection } from "@/lib/lint-fixes"
import { normalizePath } from "@/lib/path-utils"
import type { HeadingNode, SlugMode } from "@/types/ingest"

export interface H1IndexPageInput {
  slug: string
  title: string
  relativePath: string
  childSlugs: string[]
  overview: string
}

export interface H1IndexPlanItem {
  slug: string
  title: string
  relativePath: string
  childSlugs: string[]
  exists: boolean
  content: string
}

export interface EnsureH1IndexOptions {
  projectPath: string
  headingTree: HeadingNode[]
  writtenPaths: string[]
  slugMode: SlugMode
  documentName: string
  slugNamespace?: string
  sourceIdentity: string
  sourceSummarySlug: string
  wikiPageContents?: Map<string, string>
}

export interface H1IndexApplyResult {
  createdPaths: string[]
  skippedPaths: string[]
}

export function cleanHeadingTitle(title: string): string {
  return title.replace(/\*\*/g, "").trim()
}

export function listH1HeadingNodes(headingTree: HeadingNode[]): HeadingNode[] {
  return headingTree.filter((node) => node.level === 1)
}

function isH1ChapterCandidate(
  h1Node: HeadingNode,
  h1Slug: string,
  entries: HeadingNode[],
  wikiPageContents: Map<string, string>,
): boolean {
  const chapter = cleanHeadingTitle(h1Node.title)
  if (entries.some((entry) => entry.level > 1
    && cleanHeadingTitle(entry.headingPath[0] ?? "") === chapter)) {
    return true
  }
  for (const content of wikiPageContents.values()) {
    const ancestor = frontmatterSlug(parseFrontmatter(content).frontmatter?.ancestor)
    if (ancestor && lintLinkTarget(ancestor).toLowerCase() === h1Slug.toLowerCase()) {
      return true
    }
  }
  return extractH1Overview(h1Node.content).length >= 40
}

export function extractH1Overview(content: string, maxChars = 1500): string {
  const lines = content.split("\n")
  const body: string[] = []
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line.trim())) continue
    body.push(line)
  }
  const text = body.join("\n").trim()
  if (!text) return ""
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}…`
}

function formatYamlStringList(items: string[]): string {
  if (items.length === 0) return "[]"
  return `[${items.map((item) => JSON.stringify(item)).join(", ")}]`
}

function frontmatterSlug(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === "null" || trimmed === "None") return null
  return trimmed
}

function chapterTag(title: string): string {
  return lintLinkTarget(cleanHeadingTitle(title)).split("/").pop() ?? "chapter"
}

export function buildH1IndexPageContent(options: {
  title: string
  slug: string
  overview: string
  childSlugs: string[]
  sourceIdentity: string
  sourceSummarySlug: string
  created?: string
}): string {
  const today = options.created ?? new Date().toISOString().slice(0, 10)
  const displayTitle = cleanHeadingTitle(options.title)
  const overview = options.overview.trim()
    || `Chapter index for **${displayTitle}**.`

  let body = [
    "---",
    "type: concept",
    `title: ${JSON.stringify(displayTitle)}`,
    `created: ${today}`,
    `updated: ${today}`,
    `tags: ${formatYamlStringList([chapterTag(displayTitle)])}`,
    "related: []",
    `sources: ${formatYamlStringList([options.sourceIdentity])}`,
    "parent: null",
    "ancestor: null",
    "heading_level: 1",
    `heading_path: ${formatYamlStringList([displayTitle])}`,
    "ingest_strategy: encyclopedia",
    "h1_index: true",
    "---",
    "",
    `# ${displayTitle}`,
    "",
    overview,
    "",
    "## Related",
    `- [[${lintLinkTarget(options.sourceSummarySlug)}]]`,
    "",
  ].join("\n")

  if (options.childSlugs.length > 0) {
    body = mergeSubEntriesSection(body, options.childSlugs)
  }
  return body.endsWith("\n") ? body : `${body}\n`
}

export function collectChildSlugsForH1(
  h1Node: HeadingNode,
  entries: HeadingNode[],
  entrySlugs: Map<string, string>,
  wikiPageContents: Map<string, string>,
  h1Slug: string,
): string[] {
  const h1Title = cleanHeadingTitle(h1Node.title)
  const children = new Set<string>()

  for (const entry of entries) {
    if (entry.level === 1) continue
    const chapterTitle = cleanHeadingTitle(entry.headingPath[0] ?? "")
    if (chapterTitle !== h1Title) continue
    const slug = entrySlugs.get(entry.pathKey)
    if (slug && slug.toLowerCase() !== h1Slug.toLowerCase()) {
      children.add(lintLinkTarget(slug))
    }
  }

  for (const [slug, content] of wikiPageContents) {
    if (slug.toLowerCase() === h1Slug.toLowerCase()) continue
    const parsed = parseFrontmatter(content)
    const ancestor = frontmatterSlug(parsed.frontmatter?.ancestor)
    if (ancestor && lintLinkTarget(ancestor).toLowerCase() === h1Slug.toLowerCase()) {
      children.add(lintLinkTarget(slug))
      continue
    }
    const headingPath = parsed.frontmatter?.heading_path
    if (Array.isArray(headingPath) && headingPath.length > 0) {
      const chapter = cleanHeadingTitle(String(headingPath[0]))
      if (chapter === h1Title) children.add(lintLinkTarget(slug))
    }
  }

  return [...children].sort((a, b) => a.localeCompare(b))
}

export async function planH1IndexPages(
  options: EnsureH1IndexOptions,
): Promise<H1IndexPlanItem[]> {
  const pp = normalizePath(options.projectPath)
  const classification = classifyHeadings(options.headingTree, 1)
  const entrySlugs = buildEntrySlugMap(
    classification.entries,
    options.slugMode,
    options.documentName,
    options.slugNamespace ?? "",
  )
  const wikiPageContents = options.wikiPageContents ?? new Map<string, string>()
  const h1Nodes = listH1HeadingNodes(options.headingTree).filter((h1Node) => {
    const slug = computeEncyclopediaSlug(
      h1Node,
      options.slugMode,
      options.documentName,
      options.slugNamespace,
    )
    return isH1ChapterCandidate(h1Node, slug, classification.entries, wikiPageContents)
  })
  if (h1Nodes.length === 0) return []

  const items: H1IndexPlanItem[] = []

  for (const h1Node of h1Nodes) {
    const slug = computeEncyclopediaSlug(
      h1Node,
      options.slugMode,
      options.documentName,
      options.slugNamespace,
    )
    const relativePath = `wiki/concepts/${slug}.md`
    const existingPath = await resolveWikiPathForSlug(pp, slug, options.writtenPaths)
    const childSlugs = collectChildSlugsForH1(
      h1Node,
      classification.entries,
      entrySlugs,
      wikiPageContents,
      slug,
    )
    const content = buildH1IndexPageContent({
      title: h1Node.title,
      slug,
      overview: extractH1Overview(h1Node.content),
      childSlugs,
      sourceIdentity: options.sourceIdentity,
      sourceSummarySlug: options.sourceSummarySlug,
    })
    items.push({
      slug,
      title: cleanHeadingTitle(h1Node.title),
      relativePath: existingPath ?? relativePath,
      childSlugs,
      exists: existingPath !== null,
      content,
    })
  }

  return items
}

export async function applyH1IndexPages(
  options: EnsureH1IndexOptions,
): Promise<H1IndexApplyResult> {
  const pp = normalizePath(options.projectPath)
  const plan = await planH1IndexPages(options)
  const createdPaths: string[] = []
  const skippedPaths: string[] = []

  for (const item of plan) {
    if (item.exists) {
      skippedPaths.push(item.relativePath)
      continue
    }
    await writeFile(`${pp}/${item.relativePath}`, item.content)
    createdPaths.push(item.relativePath)
  }

  return { createdPaths, skippedPaths }
}

export function h1IndexPlanFromSource(
  sourceContent: string,
  options: Omit<EnsureH1IndexOptions, "headingTree">,
): Promise<H1IndexPlanItem[]> {
  return planH1IndexPages({
    ...options,
    headingTree: parseHeadingTree(sourceContent),
  })
}
