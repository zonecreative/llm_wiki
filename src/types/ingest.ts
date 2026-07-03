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
  /** Stable key derived from headingPath (lowercase, joined by " > ").
   *  Used for frequency counting and fold-map lookups. */
  pathKey: string
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
 * - `tabular` — glossary/index where each table row is a wiki entry.
 * - `mixed` — document has both encyclopedic and narrative sections
 *   (handled per-H1; reserved for future work — see PLAN step 5).
 */
export type IngestStrategy = "encyclopedia" | "narrative" | "fixed" | "mixed" | "tabular"

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
 * How wiki page slugs are computed for encyclopedia entries.
 *
 * - `default` — just the leaf heading title: "rituali"
 * - `title-concept` — document name (filename without extension) + leaf:
 *   "compendio-dei-nani-rituali". Best for compendiums where H1 is
 *   a section (Storia, Biologia) that repeats across documents.
 * - `doc-h1-leaf` — document name + H1 + leaf:
 *   "compendio-dei-nani-storia-rituali". Best for compendiums where H1
 *   is a meaningful section (Storia, Biologia) that should appear in
 *   the slug for navigation but the document name disambiguates across
 *   different compendiums.
 * - `doc-h1-h2-leaf` — document name + H1 + H2 + leaf:
 *   "compendio-dei-nani-storia-era-antica-origini". Best for deeply
 *   structured compendiums where H1+H2 provide essential context.
 * - `full-hierarchy` — entire heading path joined: "nani-cultura-rituali".
 *   Best for game manuals with deeply nested repeated structures.
 * - `manual` — a custom namespace string typed by the user + leaf:
 *   "nani-delle-montagne-rituali". Best when the document structure
 *   doesn't match the desired namespace and the user knows exactly
 *   what prefix they want.
 */
export type SlugMode = "default" | "title-concept" | "doc-h1-leaf" | "doc-h1-h2-leaf" | "full-hierarchy" | "manual"

/**
 * Per-file ingest override. Stored in `IngestStrategyConfig.fileOverrides`
 * keyed by source file basename. When present, the classifier is skipped
 * and the override strategy + slug mode are used directly.
 */
export interface FileIngestOverride {
  strategy: IngestStrategy
  /** How to compute slugs for encyclopedia entries. Default: "default". */
  slugMode?: SlugMode
  /** Custom namespace for "manual" slug mode. Ignored for other modes. */
  slugNamespace?: string
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
  /**
   * Per-file strategy overrides. Key = source file name (basename),
   * value = override config. When a file has an override, the
   * classifier is skipped entirely and the override strategy is
   * used directly. This lets the user pre-set strategies for a
   * batch ingest without monitoring each file.
   */
  fileOverrides?: Record<string, FileIngestOverride>
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
