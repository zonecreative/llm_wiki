/**
 * Heading-aware ingest types.
 *
 * These types power the heading-aware ingest strategy (Encyclopedia /
 * Narrative modes) described in plans/PLAN_heading_aware_ingest.md.
 * The pipeline lives entirely in the frontend TypeScript layer; the
 * Rust backend is untouched.
 */

/**
 * How a heading node is treated by the ingest pipeline.
 *
 * - `encyclopedia-entry` — the heading becomes a guaranteed wiki node
 *   (one FILE block per heading, with hierarchical frontmatter).
 * - `narrative-boundary` — the heading is used only as a natural chunk
 *   boundary and temporal context; no wiki page is created for the
 *   heading itself (e.g. chapter titles in a novel).
 */
export type HeadingNodeType = "encyclopedia-entry" | "narrative-boundary"

/**
 * One heading plus the content that belongs to it (everything up to
 * the next heading at the same or shallower level). Produced by
 * `parseHeadingTree` in src/lib/heading-parser.ts.
 *
 * Mirrors the Rust `HeadingNode` struct proposed in the original
 * brief, reinterpreted as a TypeScript interface.
 */
export interface HeadingNode {
  /** Full breadcrumb, e.g. ["Nani delle Montagne", "Cultura", "Rituali"]. */
  headingPath: string[]
  /** Heading level 1..6. */
  level: number
  /** The heading title text (without leading `#`). */
  title: string
  /** Body text from this heading up to the next same/shallower heading. */
  content: string
  /** Rough token estimate (chars / 4) of `content`. */
  tokenEstimate: number
  /** How this heading should be treated by the ingest pipeline. */
  nodeType: HeadingNodeType
  /** Parent heading title, or null for a top-level heading. */
  parent: string | null
  /** Nearest top-level (H1) ancestor title, or null if this IS an H1. */
  ancestor: string | null
}

/**
 * The ingest strategy chosen for a document.
 *
 * - `encyclopedia` — structured reference; one wiki node per heading.
 * - `narrative` — story/prose; headings are chapter boundaries, not entities.
 * - `fixed` — legacy token-window chunking (unchanged behavior).
 * - `mixed` — document has both encyclopedic and narrative sections
 *   (handled per-H1; reserved for future work — see PLAN step 5).
 */
export type IngestStrategy = "encyclopedia" | "narrative" | "fixed" | "mixed"

/**
 * Result of the document classifier (Level 1 heuristic, future Level 2
 * LLM). Carries enough information for the UI to show reasoning when
 * asking the user to confirm a low-confidence classification.
 */
export interface ClassificationResult {
  strategy: IngestStrategy
  /** 0.0 – 1.0. >= 0.80 → applied directly; < 0.80 → user confirmation. */
  confidence: number
  /** Which classifier level produced this result (1 = heuristic, 2 = LLM). */
  level: 1 | 2
  /** Human-readable log of the rules that fired. */
  reasoning: string[]
  /** For `mixed` strategy: per-H1 section classification. */
  sectionMap?: SectionTypeEntry[]
  /** True when confidence < 0.80 and user confirmation is required. */
  requiresUserConfirmation: boolean
}

/** One H1 section's classification, used by the future MIXED mode. */
export interface SectionTypeEntry {
  headingTitle: string
  headingLevel: number
  strategy: Exclude<IngestStrategy, "mixed">
}

/**
 * Persisted user preference for ingest strategy. Lives in the wiki
 * store and is editable from Settings → Ingest Strategy.
 */
export interface IngestStrategyConfig {
  /**
   * `auto` (default) runs the classifier and applies the result when
   * confidence >= 0.80, otherwise asks the user. The other values
   * force a specific strategy and skip classification entirely.
   */
  mode: "auto" | IngestStrategy
  /**
   * Last classification produced for the most recently ingested
   * document. Surfaced in the UI so the user can see the system's
   * reasoning. Undefined until the first ingest runs.
   */
  lastClassification?: ClassificationResult
}

/**
 * Default config: auto classification. This preserves the pre-feature
 * behavior for existing users (the classifier decides, falling back to
 * the legacy fixed-chunks path when confidence is low and the user
 * declines to choose).
 */
export const DEFAULT_INGEST_STRATEGY_CONFIG: IngestStrategyConfig = {
  mode: "auto",
}

/**
 * Confidence threshold above which the classifier's choice is applied
 * automatically without asking the user.
 */
export const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.8
