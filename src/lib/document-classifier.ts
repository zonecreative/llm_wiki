/**
 * Level-1 document classifier for the heading-aware ingest pipeline.
 *
 * Deterministic, LLM-free, < 5ms. Analyzes structural signals from the
 * markdown source to decide whether the document is an encyclopedia
 * (structured reference with many short named sections), a narrative
 * (story/novel with chapter divisions), or technical/fixed (code docs
 * or unstructured prose that should fall back to legacy chunking).
 *
 * When confidence >= CLASSIFIER_CONFIDENCE_THRESHOLD (0.80) the
 * strategy is applied directly. Below that, `requiresUserConfirmation`
 * is set and the UI (Level 4) asks the user to confirm or override.
 *
 * Pure & deterministic: same input ⇒ same output. No I/O, no globals.
 */
import type { ClassificationResult, IngestStrategy } from "@/types/ingest"
import { CLASSIFIER_CONFIDENCE_THRESHOLD } from "@/types/ingest"
import { stripFrontmatter } from "./text-chunker"

/** Rough chars-per-token ratio used by the rest of the codebase. */
const CHARS_PER_TOKEN = 4

/** Chapter-like heading patterns (Italian + English). */
const CHAPTER_HEADING_RE = /^(#{1,6})\s+(?:capitolo|chapter|parte|part|libro|book|atto|act)\b/i

/** Dialogue markers — Italian guillemets, English double quotes. */
const DIALOGUE_RE = /«[^»]{3,}»|"[^"]{3,}"/g

/** Standard YAML frontmatter opening. */
const FRONTMATTER_RE = /^---\s*\r?\n/

/**
 * Structural statistics extracted from the document body. Each signal
 * feeds into the scoring rules below. Kept as a plain object so tests
 * can inspect the raw numbers behind a classification.
 */
export interface DocumentStats {
  lineCount: number
  headingCount: number
  /** Headings per 100 lines. */
  headingDensity: number
  /** Fraction (0..1) of headings shorter than 40 chars. */
  shortHeadingRatio: number
  /** Average chars between consecutive headings. */
  avgContentBetweenHeadings: number
  /** Average estimated tokens between consecutive headings. */
  avgTokensBetweenHeadings: number
  /** Fraction (0..1) of headings matching chapter patterns. */
  chapterHeadingRatio: number
  /** Count of dialogue markers found. */
  dialogueCount: number
  /** True when a YAML frontmatter block is present. */
  hasFrontmatter: boolean
  /** Total body length in chars (frontmatter stripped). */
  bodyLength: number
}

/**
 * Compute raw structural statistics from a markdown document. Exposed
 * for tests and for the future Level-2 LLM classifier (which can use
 * the same stats as features).
 */
export function computeDocumentStats(content: string): DocumentStats {
  const hasFrontmatter = FRONTMATTER_RE.test(content)
  const { body } = stripFrontmatter(content)
  const lines = body.replace(/\r\n/g, "\n").split("\n")
  const lineCount = lines.length
  const bodyLength = body.length

  // Walk lines, track fence state, collect headings and the gaps between them.
  const headings: { level: number; title: string; lineIdx: number }[] = []
  let inFence = false
  let fenceMarker = ""

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = line.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fenceMarker = fenceMatch[1][0].repeat(fenceMatch[1].length)
      } else if (line.startsWith(fenceMarker) && line.trim() === fenceMarker) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const hMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (hMatch) {
      headings.push({
        level: hMatch[1].length,
        title: hMatch[2].trim(),
        lineIdx: i,
      })
    }
  }

  const headingCount = headings.length
  const headingDensity = lineCount > 0 ? (headingCount / lineCount) * 100 : 0

  const shortHeadingCount = headings.filter((h) => h.title.length < 40).length
  const shortHeadingRatio = headingCount > 0 ? shortHeadingCount / headingCount : 0

  // Content length between consecutive headings: from the line after a heading
  // to the line before the next heading.
  const gaps: number[] = []
  for (let i = 0; i < headings.length; i++) {
    const startLine = headings[i].lineIdx + 1
    const endLine = i + 1 < headings.length ? headings[i + 1].lineIdx : lines.length
    const gapLines = lines.slice(startLine, endLine)
    gaps.push(gapLines.join("\n").length)
  }
  const avgContentBetweenHeadings = gaps.length > 0
    ? gaps.reduce((a, b) => a + b, 0) / gaps.length
    : 0
  const avgTokensBetweenHeadings = avgContentBetweenHeadings / CHARS_PER_TOKEN

  const chapterHeadingCount = headings.filter((h) =>
    CHAPTER_HEADING_RE.test(`${"#".repeat(h.level)} ${h.title}`),
  ).length
  const chapterHeadingRatio = headingCount > 0 ? chapterHeadingCount / headingCount : 0

  const dialogueCount = (body.match(DIALOGUE_RE) || []).length

  return {
    lineCount,
    headingCount,
    headingDensity,
    shortHeadingRatio,
    avgContentBetweenHeadings,
    avgTokensBetweenHeadings,
    chapterHeadingRatio,
    dialogueCount,
    hasFrontmatter,
    bodyLength,
  }
}

interface Score {
  strategy: IngestStrategy
  /** Raw positive signal points. */
  points: number
  reasoning: string[]
}

/**
 * Heuristic classifier (Level 1). Inspects structural signals and
 * returns a `ClassificationResult` with a confidence score.
 *
 * Scoring model:
 *   - Encyclopedia signals (heading density, short headings, short
 *     sections, frontmatter) each add points.
 *   - Narrative signals (chapter headings, long sections, sparse
 *     headings, dialogue) each add points to a separate narrative score.
 *   - The winning strategy is the one with more points; confidence is
 *     the winner's share of total points, clamped to [0, 1].
 *   - When both scores are low (no strong signal either way) the
 *     strategy falls back to `fixed` with low confidence.
 */
export function heuristicClassify(content: string): ClassificationResult {
  const stats = computeDocumentStats(content)
  const reasoning: string[] = []

  const enc: Score = { strategy: "encyclopedia", points: 0, reasoning: [] }
  const nar: Score = { strategy: "narrative", points: 0, reasoning: [] }

  // When chapter-like headings dominate, ALL encyclopedia signals are
  // suppressed — chapter titles are naturally short, section length
  // varies, and even heading density can be high in a novel with many
  // short chapters. Only narrative signals should contribute.
  const chapterDominant = stats.chapterHeadingRatio > 0.5

  // ── Encyclopedia signals (suppressed when chapterDominant) ──────
  if (!chapterDominant && stats.headingDensity > 2) {
    enc.points += 2
    enc.reasoning.push(
      `heading density high (${stats.headingDensity.toFixed(1)}/100 lines)`,
    )
  } else if (!chapterDominant && stats.headingDensity > 1) {
    enc.points += 1
    enc.reasoning.push(
      `heading density moderate (${stats.headingDensity.toFixed(1)}/100 lines)`,
    )
  }

  if (!chapterDominant && stats.shortHeadingRatio > 0.7) {
    enc.points += 2
    enc.reasoning.push(
      `most headings are short (${(stats.shortHeadingRatio * 100).toFixed(0)}% < 40 chars)`,
    )
  } else if (!chapterDominant && stats.shortHeadingRatio > 0.5) {
    enc.points += 1
    enc.reasoning.push(
      `many short headings (${(stats.shortHeadingRatio * 100).toFixed(0)}% < 40 chars)`,
    )
  }

  if (
    !chapterDominant &&
    stats.headingCount > 0 &&
    stats.avgTokensBetweenHeadings < 800
  ) {
    enc.points += 2
    enc.reasoning.push(
      `short sections (avg ${Math.round(stats.avgTokensBetweenHeadings)} tokens/section)`,
    )
  } else if (
    !chapterDominant &&
    stats.headingCount > 0 &&
    stats.avgTokensBetweenHeadings < 1500
  ) {
    enc.points += 1
    enc.reasoning.push(
      `moderate sections (avg ${Math.round(stats.avgTokensBetweenHeadings)} tokens/section)`,
    )
  }

  if (!chapterDominant && stats.hasFrontmatter) {
    enc.points += 1
    enc.reasoning.push("YAML frontmatter present (typical of reference docs)")
  }

  // ── Narrative signals ───────────────────────────────────────────
  if (stats.chapterHeadingRatio > 0.5) {
    nar.points += 4
    nar.reasoning.push(
      `most headings are chapter-like (${(stats.chapterHeadingRatio * 100).toFixed(0)}%)`,
    )
  } else if (stats.chapterHeadingRatio > 0.2) {
    nar.points += 2
    nar.reasoning.push(
      `some chapter-like headings (${(stats.chapterHeadingRatio * 100).toFixed(0)}%)`,
    )
  }

  if (stats.headingCount > 0 && stats.avgTokensBetweenHeadings > 800) {
    nar.points += 2
    nar.reasoning.push(
      `long sections (avg ${Math.round(stats.avgTokensBetweenHeadings)} tokens/section — chapter-length)`,
    )
  }

  if (stats.headingDensity < 0.5 && stats.lineCount > 50) {
    nar.points += 1
    nar.reasoning.push(
      `sparse headings (${stats.headingDensity.toFixed(2)}/100 lines — prose-like)`,
    )
  }

  if (stats.dialogueCount > 5) {
    nar.points += 2
    nar.reasoning.push(
      `frequent dialogue markers (${stats.dialogueCount} found)`,
    )
  } else if (stats.dialogueCount > 0) {
    nar.points += 1
    nar.reasoning.push(`dialogue markers present (${stats.dialogueCount})`)
  }

  // ── Decide winner ───────────────────────────────────────────────
  const total = enc.points + nar.points
  let strategy: IngestStrategy
  let confidence: number
  let winnerReasoning: string[]

  if (total === 0) {
    // No structural signal at all — likely unstructured prose or code.
    strategy = "fixed"
    confidence = 0.5
    winnerReasoning = ["no strong structural signal — defaulting to fixed chunks"]
  } else if (enc.points > nar.points) {
    strategy = "encyclopedia"
    confidence = enc.points / total
    winnerReasoning = enc.reasoning
  } else if (nar.points > enc.points) {
    strategy = "narrative"
    confidence = nar.points / total
    winnerReasoning = nar.reasoning
  } else {
    // Tie — ambiguous document.
    strategy = "fixed"
    confidence = 0.4
    winnerReasoning = [
      ...enc.reasoning,
      ...nar.reasoning,
      "tie between encyclopedia and narrative signals — defaulting to fixed chunks",
    ]
  }

  reasoning.push(
    `stats: ${stats.headingCount} headings, density ${stats.headingDensity.toFixed(1)}/100, ` +
      `avg ${Math.round(stats.avgTokensBetweenHeadings)} tok/section, ` +
      `${stats.dialogueCount} dialogue markers`,
  )
  reasoning.push(...winnerReasoning)

  return {
    strategy,
    confidence: Math.round(confidence * 100) / 100,
    level: 1,
    reasoning,
    requiresUserConfirmation: confidence < CLASSIFIER_CONFIDENCE_THRESHOLD,
  }
}

/**
 * Convenience wrapper: classify and return just the strategy. Used by
 * callers that don't need the reasoning (e.g. cache key computation).
 */
export function classifyStrategy(content: string): IngestStrategy {
  return heuristicClassify(content).strategy
}
