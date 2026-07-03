/**
 * Single source of truth for resolving the effective ingest strategy.
 * Used by the ingest pipeline, settings UI, and batch ingest preview.
 */
import { heuristicClassify } from "@/lib/document-classifier"
import type {
  ClassificationResult,
  FileIngestOverride,
  IngestStrategy,
  IngestStrategyConfig,
} from "@/types/ingest"
import { CLASSIFIER_CONFIDENCE_THRESHOLD } from "@/types/ingest"

/** Non-interactive: below primary threshold but above this → use classifier best guess. */
export const CLASSIFIER_SECONDARY_THRESHOLD = 0.5

export type ResolveSource =
  | "file-override"
  | "forced-mode"
  | "classifier"
  | "classifier-conservative-fallback"

export interface ResolveIngestStrategyInput {
  content: string
  config: IngestStrategyConfig
  fileName?: string
  /** When true, low confidence may trigger a confirmation dialog in the pipeline. */
  interactive?: boolean
}

export interface ResolveIngestStrategyResult {
  strategy: IngestStrategy
  classification?: ClassificationResult
  requiresUserPrompt: boolean
  source: ResolveSource
}

/** Backward compat: old overrides were plain strategy strings. */
export function normalizeFileOverride(
  raw: FileIngestOverride | IngestStrategy | string | undefined,
): FileIngestOverride | undefined {
  if (!raw) return undefined
  if (typeof raw === "string") return { strategy: raw as IngestStrategy }
  return raw
}

/**
 * Resolve the effective ingest strategy synchronously.
 * Interactive confirmation dialogs are handled by the caller when
 * `requiresUserPrompt` is true.
 */
export function resolveIngestStrategy(
  input: ResolveIngestStrategyInput,
): ResolveIngestStrategyResult {
  const { content, config, fileName, interactive = false } = input

  if (fileName) {
    const override = normalizeFileOverride(config.fileOverrides?.[fileName])
    if (override) {
      return {
        strategy: override.strategy,
        source: "file-override",
        requiresUserPrompt: false,
      }
    }
  }

  if (config.mode !== "auto") {
    return {
      strategy: config.mode,
      source: "forced-mode",
      requiresUserPrompt: false,
    }
  }

  const classification = heuristicClassify(content)

  if (classification.confidence >= CLASSIFIER_CONFIDENCE_THRESHOLD) {
    return {
      strategy: classification.strategy,
      classification,
      source: "classifier",
      requiresUserPrompt: false,
    }
  }

  if (interactive) {
    return {
      strategy: classification.strategy,
      classification,
      source: "classifier",
      requiresUserPrompt: true,
    }
  }

  if (classification.confidence >= CLASSIFIER_SECONDARY_THRESHOLD) {
    return {
      strategy: classification.strategy,
      classification,
      source: "classifier",
      requiresUserPrompt: false,
    }
  }

  return {
    strategy: "fixed",
    classification,
    source: "classifier-conservative-fallback",
    requiresUserPrompt: false,
  }
}
