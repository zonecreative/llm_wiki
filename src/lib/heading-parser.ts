/**
 * Heading tree parser for the heading-aware ingest pipeline.
 *
 * Produces a structured `HeadingNode[]` from a markdown document,
 * where each node carries its full breadcrumb (`headingPath`), parent,
 * ancestor, and the body text that belongs to it. Headings inside
 * fenced code blocks are ignored (CommonMark behavior), and a leading
 * YAML frontmatter block is stripped before parsing so metadata
 * doesn't pollute the tree.
 *
 * The fence-aware heading walk mirrors `splitIntoSections` in
 * src/lib/text-chunker.ts but emits structured `HeadingNode` objects
 * (with `parent`/`ancestor`/`headingPath[]`) instead of flat sections
 * with a formatted string. Keeping a dedicated parser avoids exposing
 * internals of the chunker and lets the heading tree carry the
 * hierarchy metadata the encyclopedia-mode prompt needs.
 *
 * Pure & deterministic: same input ⇒ same output. No I/O, no globals.
 */
import { stripFrontmatter } from "./text-chunker"
import type { HeadingNode, HeadingNodeType } from "@/types/ingest"

/**
 * Parse a markdown document into a list of heading nodes, each with
 * its full hierarchy and the content that belongs to it.
 *
 * @param content Markdown source (may include YAML frontmatter)
 * @param nodeType How headings should be treated by the ingest
 *   pipeline. `encyclopedia-entry` for the encyclopedia strategy,
 *   `narrative-boundary` for the narrative strategy. The parser is
 *   strategy-agnostic — this just stamps the caller's intent onto
 *   every node so downstream code doesn't need to re-derive it.
 * @returns Heading nodes in document order. Empty array when the
 *   document has no headings (or only headings inside code fences).
 */
export function parseHeadingTree(
  content: string,
  nodeType: HeadingNodeType = "encyclopedia-entry",
): HeadingNode[] {
  const { body } = stripFrontmatter(content)
  if (body.trim().length === 0) return []

  const lines = body.replace(/\r\n/g, "\n").split("\n")

  // Heading stack keyed by level: stack[level] = title of last heading at that level.
  const stack: Record<number, string> = {}
  const nodes: HeadingNode[] = []

  let currentHeadingPath: string[] = []
  let currentLevel = 0
  let currentTitle = ""
  let currentBody: string[] = []
  let inFence = false
  let fenceMarker = ""

  const flushCurrent = () => {
    const bodyText = currentBody.join("\n").trim()
    // Emit a node only if there was a heading. The preamble before the
    // first heading (currentLevel === 0) is intentionally dropped —
    // the encyclopedia strategy keys off headings, not free prose.
    if (currentLevel > 0) {
      nodes.push({
        headingPath: [...currentHeadingPath],
        level: currentLevel,
        title: currentTitle,
        content: bodyText,
        tokenEstimate: Math.ceil(bodyText.length / 4),
        nodeType,
        parent: currentHeadingPath.length > 1
          ? currentHeadingPath[currentHeadingPath.length - 2]
          : null,
        ancestor: currentHeadingPath.length > 0 ? currentHeadingPath[0] : null,
      })
    }
    currentBody = []
  }

  for (const line of lines) {
    // Track fenced code state first — inside a fence, nothing else matters.
    const fenceMatch = line.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fenceMarker = fenceMatch[1][0].repeat(fenceMatch[1].length)
      } else if (line.startsWith(fenceMarker) && line.trim() === fenceMarker) {
        inFence = false
      }
      currentBody.push(line)
      continue
    }

    // Heading detection only outside fences.
    const hMatch = !inFence ? line.match(/^(#{1,6})\s+(.+?)\s*$/) : null
    if (hMatch) {
      flushCurrent()
      const level = hMatch[1].length
      const title = hMatch[2].trim()
      stack[level] = title
      // Clear deeper levels (a level-2 heading resets level-3, level-4, …)
      for (let lvl = level + 1; lvl <= 6; lvl++) delete stack[lvl]

      // Rebuild the breadcrumb from the stack.
      const path: string[] = []
      for (let lvl = 1; lvl <= 6; lvl++) {
        if (stack[lvl]) path.push(stack[lvl])
      }
      currentHeadingPath = path
      currentLevel = level
      currentTitle = title
      currentBody = [line]
      continue
    }

    currentBody.push(line)
  }

  flushCurrent()
  return nodes
}

/**
 * Filter heading nodes to those at or below a minimum level. Used by
 * the encyclopedia strategy to decide which headings become guaranteed
 * wiki nodes (e.g. only `##` and `###`, not `#`).
 *
 * @param nodes Heading tree from `parseHeadingTree`
 * @param minLevel Minimum heading level to keep (1..6). Default 2.
 */
export function filterByMinLevel(
  nodes: HeadingNode[],
  minLevel: number = 2,
): HeadingNode[] {
  return nodes.filter((n) => n.level >= minLevel)
}

/**
 * Minimum body length (in chars) for a heading to be considered a
 * "content-bearing entry" vs a "context-only heading" (a heading that
 * just establishes hierarchy but has no real text under it).
 *
 * Headings with fewer than this many chars of body text are treated
 * as structural context: they appear in the `heading_path` of their
 * children but do NOT get their own wiki page. This prevents dozens
 * of empty stub pages like "Storia antica" or "Periodo 1000-1500"
 * that exist only to organize sub-sections.
 *
 * 80 chars ≈ 1-2 short sentences. A heading with less than that
 * is almost certainly a pure organizer.
 */
const MIN_CONTENT_CHARS = 40

/**
 * Minimum heading level to consider as a potential encyclopedia entry.
 * Level 1 = H1 (the document's main title / top-level sections).
 * Level 2 = H2, etc.
 *
 * Default is 1: H1 headings CAN be entries if they have content.
 * A document like the Compendio dei Nani uses H1 for top-level
 * sections (Storia, Cultura, Personaggi) which DO have content
 * and SHOULD get wiki pages.
 */
const DEFAULT_MIN_LEVEL = 1

/**
 * Split a heading tree into:
 *   - `entries`: headings that have enough body text to warrant a wiki page
 *   - `context`: headings that exist only for hierarchy (their title
 *     still appears in children's `heading_path` for context, but no
 *     wiki page is created for them)
 *
 * This is the key quality filter for the encyclopedia strategy: a
 * deeply-structured compendium like the Compendio dei Nani has 4-6
 * levels of headings, but many intermediate levels (e.g. "Storia
 * antica" → "Periodo 1000-1500") have no real text — they exist
 * purely to nest their children. Without this filter, the pipeline
 * would produce dozens of empty stub pages.
 *
 * @param minLevel Minimum heading level to consider (default 1 = H1).
 *   Use 2 to skip the document title and only process sub-sections.
 */
export function filterEntriesWithContent(
  nodes: HeadingNode[],
  minLevel: number = DEFAULT_MIN_LEVEL,
  minContentChars: number = MIN_CONTENT_CHARS,
): { entries: HeadingNode[]; context: HeadingNode[] } {
  const candidates = filterByMinLevel(nodes, minLevel)
  const entries: HeadingNode[] = []
  const context: HeadingNode[] = []

  for (const node of candidates) {
    // "Content" = body text minus the heading line itself. A heading
    // like "## Cultura\nIntro breve." has ~11 chars of body — too
    // short. One like "### Rituali\nI rituali dei Nani sono cerimonie..."
    // has 100+ chars — enough for a wiki page.
    const bodyText = node.content
      .replace(/^#{1,6}\s+.+$/m, "") // strip the heading line itself
      .trim()

    if (bodyText.length >= minContentChars) {
      entries.push(node)
    } else {
      context.push(node)
    }
  }

  return { entries, context }
}

/**
 * Count how many heading nodes would become encyclopedia entries
 * (i.e. are at or below `minLevel` AND have enough body text).
 * Convenience for the post-generation drift check that compares
 * FILE blocks produced vs headings available.
 */
export function countEncyclopediaEntries(
  nodes: HeadingNode[],
  minLevel: number = DEFAULT_MIN_LEVEL,
  minContentChars: number = MIN_CONTENT_CHARS,
): number {
  return filterEntriesWithContent(nodes, minLevel, minContentChars).entries.length
}
