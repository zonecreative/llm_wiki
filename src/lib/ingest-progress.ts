/**
 * User-visible ingest progress messages (i18n-backed).
 * Keeps the current step and warnings separate so step updates don't erase warnings.
 */
import i18n from "@/i18n"
import { useActivityStore } from "@/stores/activity-store"
import type { IngestStrategy } from "@/types/ingest"
import type { SectionTypeEntry } from "@/types/ingest"

interface IngestActivityState {
  plan: string
  step: string
  warnings: string[]
}

const stateByActivity = new Map<string, IngestActivityState>()

function progressT(key: string, params?: Record<string, unknown>): string {
  return i18n.t(`ingestProgress.${key}`, params ?? {})
}

function strategyName(strategy: IngestStrategy): string {
  return progressT(`strategy.${strategy}`)
}

function buildDetail(state: IngestActivityState): string {
  const lines = [
    state.plan,
    state.step,
    ...state.warnings.map((w) => `⚠ ${w}`),
  ].filter(Boolean)
  return lines.join("\n")
}

function getState(activityId: string): IngestActivityState {
  return stateByActivity.get(activityId) ?? { plan: "", step: "", warnings: [] }
}

function pushDetail(activityId: string, state: IngestActivityState): void {
  stateByActivity.set(activityId, state)
  useActivityStore.getState().updateItem(activityId, { detail: buildDetail(state) })
}

/** Reset per-activity progress tracking (call when ingest finishes). */
export function clearIngestProgress(activityId: string): void {
  stateByActivity.delete(activityId)
}

/** Set the current step line shown in the activity panel. */
export function setIngestStep(activityId: string, step: string): void {
  const state = getState(activityId)
  state.step = step
  pushDetail(activityId, state)
}

/** Append a warning line persisted across subsequent step updates. */
export function addIngestWarning(activityId: string, warning: string): void {
  const state = getState(activityId)
  if (state.warnings.includes(warning)) return
  state.warnings.push(warning)
  pushDetail(activityId, state)
}

export function ingestReadingSource(activityId: string): void {
  setIngestStep(activityId, progressT("readingSource"))
}

export function ingestMineruParsing(activityId: string): void {
  setIngestStep(activityId, progressT("mineruParsing"))
}

export function ingestMineruProgress(activityId: string, msg: string): void {
  setIngestStep(activityId, progressT("mineruProgress", { msg }))
}

export function ingestMineruFallback(activityId: string, error: string): void {
  setIngestStep(activityId, progressT("mineruFallback", { error }))
}

export function ingestCancelledDetail(): string {
  return progressT("cancelled")
}

export function ingestExtractingImages(activityId: string): void {
  setIngestStep(activityId, progressT("extractingImages"))
}

export function ingestCaptioningImages(
  activityId: string,
  done?: number,
  total?: number,
): void {
  if (done !== undefined && total !== undefined) {
    setIngestStep(activityId, progressT("captioningProgress", { done, total }))
  } else {
    setIngestStep(activityId, progressT("captioningImages"))
  }
}

export function ingestSkippedUnchanged(activityId: string, count: number): void {
  setIngestStep(activityId, progressT("skippedUnchanged", { count }))
}

export function ingestStep1(activityId: string, consolidating: boolean): void {
  setIngestStep(activityId, progressT(consolidating ? "step1Consolidating" : "step1Analyzing"))
}

export function ingestStep2(activityId: string): void {
  setIngestStep(activityId, progressT("step2Generating"))
}

export function ingestWritingFiles(activityId: string): void {
  setIngestStep(activityId, progressT("writingFiles"))
}

export interface IngestPlanSummary {
  strategy: IngestStrategy
  source?: "override" | "classifier" | "fallback" | "forced"
  confidence?: number
  encyclopediaEntries?: number
  encyclopediaBatches?: number
  narrativeChapters?: number
  tabularRows?: number
  tabularBatches?: number
  mixedSections?: SectionTypeEntry[]
}

function buildPlanSummary(params: IngestPlanSummary): string {
  const {
    strategy,
    encyclopediaEntries = 0,
    encyclopediaBatches = 0,
    narrativeChapters = 0,
    tabularRows = 0,
    tabularBatches = 0,
    mixedSections,
  } = params

  if (strategy === "mixed" && mixedSections && mixedSections.length > 0) {
    const sections = mixedSections
      .map((s) => progressT("mixedSectionLine", { title: s.headingTitle, strategy: strategyName(s.strategy) }))
      .join(", ")
    return progressT("summaryMixed", { sections })
  }

  if (strategy === "encyclopedia" && encyclopediaEntries > 0) {
    const batchHint =
      encyclopediaBatches > 1
        ? progressT("batchHint", { batches: encyclopediaBatches })
        : ""
    return progressT("summaryEncyclopedia", { entries: encyclopediaEntries, batchHint })
  }

  if (strategy === "tabular" && tabularRows > 0) {
    return progressT("summaryTabular", { rows: tabularRows, batches: tabularBatches || 1 })
  }

  if (strategy === "narrative" && narrativeChapters > 0) {
    return progressT("summaryNarrative", { chapters: narrativeChapters })
  }

  return progressT("summaryFixed")
}

/** Show resolved strategy and document shape (persists as header line). */
export function announceIngestPlan(activityId: string, params: IngestPlanSummary): void {
  const summary = buildPlanSummary(params)
  const strategy = strategyName(params.strategy)

  let plan: string
  if (params.source === "override") {
    plan = progressT("planOverride", { strategy, summary })
  } else if (params.source === "fallback" && params.confidence !== undefined) {
    plan = progressT("planFallback", { pct: Math.round(params.confidence * 100) })
  } else if (
    params.confidence !== undefined &&
    params.confidence < 0.8 &&
    params.source === "classifier"
  ) {
    plan = progressT("planLowConfidence", {
      strategy,
      pct: Math.round(params.confidence * 100),
      summary,
    })
  } else {
    plan = progressT("planIntro", { strategy, summary })
  }

  const state = getState(activityId)
  state.plan = plan
  pushDetail(activityId, state)
}

export function ingestEncBatchGenerate(
  activityId: string,
  current: number,
  total: number,
  entries: number,
): void {
  setIngestStep(activityId, progressT("encBatchGenerate", { current, total, entries }))
}

export function ingestEncBatchWrite(activityId: string, current: number, total: number): void {
  setIngestStep(activityId, progressT("encBatchWrite", { current, total }))
}

export function ingestEncResume(activityId: string, current: number, total: number): void {
  setIngestStep(activityId, progressT("encResume", { current, total }))
}

export function ingestEncGapFill(activityId: string, count: number): void {
  setIngestStep(activityId, progressT("encGapFill", { count }))
}

export function ingestEncAggregate(activityId: string): void {
  setIngestStep(activityId, progressT("encAggregate"))
}

export function ingestTabBatchGenerate(
  activityId: string,
  current: number,
  total: number,
  rows: number,
): void {
  setIngestStep(activityId, progressT("tabBatchGenerate", { current, total, rows }))
}

export function ingestTabBatchWrite(activityId: string, current: number, total: number): void {
  setIngestStep(activityId, progressT("tabBatchWrite", { current, total }))
}

export function ingestTabResume(activityId: string, current: number, total: number): void {
  setIngestStep(activityId, progressT("tabResume", { current, total }))
}

export function ingestTabAggregate(activityId: string): void {
  setIngestStep(activityId, progressT("tabAggregate"))
}

export function ingestLongSourceResume(
  activityId: string,
  current: number,
  total: number,
): void {
  setIngestStep(activityId, progressT("longSourceResume", { current, total }))
}

export function ingestLongSourceChunk(
  activityId: string,
  current: number,
  total: number,
): void {
  setIngestStep(activityId, progressT("longSourceChunk", { current, total }))
}

export function ingestRepairAggregates(activityId: string, paths: string[]): void {
  setIngestStep(activityId, progressT("repairAggregates", { paths: paths.join(", ") }))
}

export function warnDrift(activityId: string, pct: number, missing: string[]): void {
  const preview = missing.slice(0, 5).join(", ")
  const suffix = missing.length > 5 ? ", ..." : ""
  addIngestWarning(activityId, progressT("warningDrift", { pct, missing: preview + suffix }))
}

export function warnChapterPages(activityId: string, paths: string[]): void {
  addIngestWarning(activityId, progressT("warningChapterPages", { paths: paths.join(", ") }))
}

export function warnSourceHub(activityId: string, count: number, min: number): void {
  addIngestWarning(activityId, progressT("warningSourceHub", { count, min }))
}

/** Summarize parser/writer warnings for the done line and activity panel. */
export function ingestWriteWarnings(activityId: string, warnings: readonly string[]): string {
  if (warnings.length === 0) return ""

  const summary =
    warnings.length === 1
      ? warnings[0]
      : progressT("writeWarningsSummary", {
          count: warnings.length,
          preview: warnings.slice(0, 2).join(" · "),
          extraHint:
            warnings.length > 2
              ? progressT("writeWarningsExtraHint", { extra: warnings.length - 2 })
              : "",
        })

  for (const warning of warnings.slice(0, 3)) {
    addIngestWarning(activityId, warning)
  }
  if (warnings.length > 3) {
    addIngestWarning(activityId, progressT("writeWarningsMore", { count: warnings.length - 3 }))
  }
  return summary
}

export function formatIngestDoneDetail(
  filesWritten: number,
  reviewCount: number,
  warningSummary?: string,
  activityId?: string,
): string {
  if (filesWritten === 0) return progressT("noFilesGenerated")
  let detail = progressT("doneFiles", { count: filesWritten })
  if (reviewCount > 0) detail += progressT("doneReview", { count: reviewCount })
  if (warningSummary) detail += progressT("doneWarningsLogged", { warnings: warningSummary })
  if (activityId) {
    const warnings = getState(activityId).warnings
    if (warnings.length > 0) {
      detail += "\n" + warnings.map((w) => `⚠ ${w}`).join("\n")
    }
  }
  return detail
}

export function ingestErrorDetail(
  kind: "analysis" | "generation" | "batch" | "chunk",
  error: string,
  batch?: number,
): string {
  if (kind === "analysis") return progressT("analysisFailed", { error })
  if (kind === "generation") return progressT("generationFailed", { error })
  if (kind === "batch" && batch !== undefined) return progressT("batchFailed", { batch, error })
  return progressT("chunkFailed", { error })
}
