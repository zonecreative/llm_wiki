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
import { makeQuerySlug } from "./wiki-filename"
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
        pathKey: currentHeadingPath.join(" > ").toLowerCase(),
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
 * How many times a heading title must appear (case-insensitive)
 * across the document before it's classified as "structural" rather
 * than "entry". Structural headings are repeated boilerplate fields
 * like "Danni", "Effetti Collaterali", "Descrizione" that appear
 * under every spell/weapon/item in a game manual.
 *
 * Threshold of 3 means: if a title appears 1-2 times it's treated as
 * a legitimate unique entry; 3+ times it's structural and gets folded
 * into its parent entry.
 */
const STRUCTURAL_FREQUENCY_THRESHOLD = 3

/**
 * Result of the 3-way heading classification.
 *
 * - `entries`: headings that become dedicated wiki pages. They have
 *   unique titles and enough content (either their own or absorbed
 *   from folded structural children).
 * - `structural`: headings whose title repeats ≥ threshold times
 *   across the document. Their content is folded into the nearest
 *   entry ancestor — they do NOT get their own wiki page.
 * - `context`: headings with too little content and no structural
 *   children to fold. They exist only for hierarchy; their title
 *   appears in children's `heading_path` but no page is created.
 */
export interface HeadingClassification {
  entries: HeadingNode[]
  structural: HeadingNode[]
  context: HeadingNode[]
  /**
   * For each structural heading, the nearest entry ancestor that
   * absorbs its content. Key = structural heading path, value =
   * entry heading path. Undefined when no entry ancestor exists
   * (structural falls back to becoming an entry itself).
   */
  foldMap: Map<string, string | null>
}

/**
 * Classify headings into three categories: entries, structural, and
 * context. This is the core quality filter for the encyclopedia
 * strategy.
 *
 * The classification is **iterative**:
 *   1. Count title frequencies → mark structural headings (≥ threshold)
 *   2. Compute "effective content" for each non-structural heading:
 *      own body + body of all structural descendants
 *   3. Classify: effective content ≥ minChars → entry; else → context
 *
 * Step 2 is the key insight: a heading that was originally "context"
 * (too little own content) can become an "entry" after absorbing the
 * content of its structural children. For example:
 *
 *   ## Palla di Fuoco        → context ("Una magia di fuoco." = 18 chars)
 *   ### Danni                → structural (repeated 50×)
 *   ### Effetti Collaterali  → structural (repeated 50×)
 *
 * After folding, "Palla di Fuoco" has 18 + Danni + Effetti chars → entry.
 *
 * @param minLevel Minimum heading level to consider (default 1 = H1).
 * @param minContentChars Minimum body chars for an entry (default 40).
 * @param frequencyThreshold How many repetitions make a heading structural (default 3).
 */
export function classifyHeadings(
  nodes: HeadingNode[],
  minLevel: number = DEFAULT_MIN_LEVEL,
  minContentChars: number = MIN_CONTENT_CHARS,
  frequencyThreshold: number = STRUCTURAL_FREQUENCY_THRESHOLD,
): HeadingClassification {
  const candidates = filterByMinLevel(nodes, minLevel)
  if (candidates.length === 0) {
    return { entries: [], structural: [], context: [], foldMap: new Map() }
  }

  // ── Step 1: count title frequencies (case-insensitive) ──────────
  const titleCounts = new Map<string, number>()
  for (const node of candidates) {
    const key = node.title.toLowerCase().trim()
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)
  }

  // ── Step 2: mark structural headings ─────────────────────────────
  const structuralSet = new Set<string>()
  for (const node of candidates) {
    const key = node.title.toLowerCase().trim()
    if ((titleCounts.get(key) ?? 0) >= frequencyThreshold) {
      structuralSet.add(node.pathKey)
    }
  }

  // ── Step 3: compute effective content for non-structural headings ──
  // Effective content = own body + sum of structural descendants' bodies.
  // A "structural descendant" is any structural heading whose headingPath
  // extends this heading's headingPath (i.e., it's deeper in the same branch).
  const entries: HeadingNode[] = []
  const structural: HeadingNode[] = []
  const context: HeadingNode[] = []
  const foldMap = new Map<string, string | null>()

  for (const node of candidates) {
    if (structuralSet.has(node.pathKey)) {
      structural.push(node)
      // Find nearest entry ancestor (will be resolved in second pass)
      foldMap.set(node.pathKey, null)
      continue
    }

    // Compute effective content: own body + structural descendants
    const ownBody = node.content
      .replace(/^#{1,6}\s+.+$/m, "")
      .trim()

    let effectiveLen = ownBody.length
    for (const other of candidates) {
      if (!structuralSet.has(other.pathKey)) continue
      if (!isDescendantOf(other, node)) continue
      const childBody = other.content
        .replace(/^#{1,6}\s+.+$/m, "")
        .trim()
      effectiveLen += childBody.length
    }

    if (effectiveLen >= minContentChars) {
      entries.push(node)
    } else {
      context.push(node)
    }
  }

  // ── Step 4: resolve fold targets ─────────────────────────────────
  // For each structural heading, find the nearest entry ancestor.
  // If no entry ancestor exists, the structural heading becomes an
  // entry itself (fallback — better to create the page than lose content).
  const entryPathKeys = new Set(entries.map((e) => e.pathKey))

  for (const node of structural) {
    let ancestor: HeadingNode | null = null
    // Walk up the headingPath to find the nearest entry ancestor
    for (let i = node.headingPath.length - 2; i >= 0; i--) {
      const ancestorPath = node.headingPath.slice(0, i + 1)
      const ancestorKey = ancestorPath.join(" > ").toLowerCase()
      // Find the candidate with this headingPath
      const found = candidates.find(
        (c) => c.headingPath.join(" > ").toLowerCase() === ancestorKey,
      )
      if (found && entryPathKeys.has(found.pathKey)) {
        ancestor = found
        break
      }
    }

    if (ancestor) {
      foldMap.set(node.pathKey, ancestor.pathKey)
    } else {
      // No entry ancestor — promote structural to entry
      foldMap.set(node.pathKey, null)
      entries.push(node)
      structural.splice(structural.indexOf(node), 1)
      entryPathKeys.add(node.pathKey)
    }
  }

  return { entries, structural, context, foldMap }
}

/**
 * Check if `child` is a descendant of `parent` in the heading tree.
 * A node is a descendant if its headingPath extends the parent's
 * headingPath (i.e., parent's path is a prefix of child's path).
 */
function isDescendantOf(child: HeadingNode, parent: HeadingNode): boolean {
  if (child.headingPath.length <= parent.headingPath.length) return false
  for (let i = 0; i < parent.headingPath.length; i++) {
    if (child.headingPath[i] !== parent.headingPath[i]) return false
  }
  return true
}

/**
 * Backward-compatible wrapper around `classifyHeadings` that returns
 * the old 2-category shape (entries + context). Structural headings
 * are merged into entries (they were promoted or folded).
 *
 * @deprecated Use `classifyHeadings` directly for the 3-category result.
 */
export function filterEntriesWithContent(
  nodes: HeadingNode[],
  minLevel: number = DEFAULT_MIN_LEVEL,
  minContentChars: number = MIN_CONTENT_CHARS,
): { entries: HeadingNode[]; context: HeadingNode[] } {
  const { entries, context } = classifyHeadings(nodes, minLevel, minContentChars)
  return { entries, context }
}

/**
 * Count how many heading nodes would become encyclopedia entries
 * (i.e. are at or below `minLevel`, have enough content, and are
 * not structural). Convenience for the post-generation drift check.
 */
export function countEncyclopediaEntries(
  nodes: HeadingNode[],
  minLevel: number = DEFAULT_MIN_LEVEL,
  minContentChars: number = MIN_CONTENT_CHARS,
): number {
  return classifyHeadings(nodes, minLevel, minContentChars).entries.length
}

/**
 * Compute the wiki slug for an encyclopedia entry using the
 * "H1 + leaf" rule: the H1 (top-level ancestor) provides the
 * namespace, and the leaf heading (this entry's own title) provides
 * the unique identifier within that namespace.
 *
 * Examples:
 *   headingPath: ["Nani delle Montagne", "Cultura", "Rituali"]
 *   → slug: "nani-delle-montagne-rituali"
 *
 *   headingPath: ["Manuale GDR", "Magie", "Palla di Fuoco"]
 *   → slug: "manuale-gdr-palla-di-fuoco"
 *
 * This rule ensures:
 *   1. No cross-document collisions (different H1 → different prefix)
 *   2. No cross-population confusion ("Nani delle Montagne" vs
 *      "Nani delle Pianure" → different H1 → different slug)
 *   3. Readable slugs (only 2 segments, not the full hierarchy)
 *   4. The full hierarchy is preserved in frontmatter `heading_path`,
 *      `parent`, and `ancestor` — the slug doesn't need to encode it
 *
 * @param node The heading node to compute a slug for
 * @returns kebab-case slug like "nani-delle-montagne-rituali"
 */
export function computeEncyclopediaSlug(node: HeadingNode): string {
  const ancestor = node.headingPath[0] ?? node.title
  const leaf = node.title
  const ancestorSlug = makeQuerySlug(ancestor)
  const leafSlug = makeQuerySlug(leaf)
  return `${ancestorSlug}-${leafSlug}`
}

/**
 * Build a map of entry pathKey → suggested slug for all entries in
 * a classification. Used by the generation prompt to pre-compute
 * slugs so the LLM doesn't have to guess (and stays consistent).
 */
export function computeEntrySlugs(
  entries: HeadingNode[],
): Map<string, string> {
  const slugs = new Map<string, string>()
  for (const entry of entries) {
    slugs.set(entry.pathKey, computeEncyclopediaSlug(entry))
  }
  return slugs
}
