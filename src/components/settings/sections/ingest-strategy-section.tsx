import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { BookOpen, ScrollText, FileText, Sparkles } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import {
  saveIngestStrategyConfig,
  loadIngestStrategyConfig,
} from "@/lib/project-store"
import { heuristicClassify } from "@/lib/document-classifier"
import type { IngestStrategyConfig } from "@/types/ingest"
import type { IngestStrategy, ClassificationResult } from "@/types/ingest"

const STRATEGY_OPTIONS: Array<{
  value: IngestStrategyConfig["mode"]
  icon: typeof BookOpen
  labelKey: string
  descKey: string
}> = [
  {
    value: "auto",
    icon: Sparkles,
    labelKey: "settings.sections.ingestStrategy.modeAuto",
    descKey: "settings.sections.ingestStrategy.modeAutoDesc",
  },
  {
    value: "encyclopedia",
    icon: BookOpen,
    labelKey: "settings.sections.ingestStrategy.modeEncyclopedia",
    descKey: "settings.sections.ingestStrategy.modeEncyclopediaDesc",
  },
  {
    value: "narrative",
    icon: ScrollText,
    labelKey: "settings.sections.ingestStrategy.modeNarrative",
    descKey: "settings.sections.ingestStrategy.modeNarrativeDesc",
  },
  {
    value: "fixed",
    icon: FileText,
    labelKey: "settings.sections.ingestStrategy.modeFixed",
    descKey: "settings.sections.ingestStrategy.modeFixedDesc",
  },
]

export function IngestStrategySection() {
  const { t } = useTranslation()
  const config = useWikiStore((s) => s.ingestStrategyConfig)
  const setConfig = useWikiStore((s) => s.setIngestStrategyConfig)
  const [saved, setSaved] = useState(false)

  // Load persisted config on mount
  useEffect(() => {
    loadIngestStrategyConfig()
      .then((persisted) => {
        if (persisted) setConfig(persisted)
      })
      .catch(() => {})
  }, [setConfig])

  const handleSelect = async (mode: IngestStrategyConfig["mode"]) => {
    const newConfig: IngestStrategyConfig = { ...config, mode }
    setConfig(newConfig)
    try {
      await saveIngestStrategyConfig(newConfig)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      console.error("[ingest-strategy] failed to save:", err)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.ingestStrategy.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.ingestStrategy.description")}
        </p>
      </div>

      <div className="space-y-3">
        {STRATEGY_OPTIONS.map((opt) => {
          const Icon = opt.icon
          const active = config.mode === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleSelect(opt.value)}
              className={`flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                active
                  ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              <Icon
                className={`mt-0.5 h-5 w-5 shrink-0 ${
                  active ? "text-primary" : "text-muted-foreground"
                }`}
              />
              <div className="flex-1">
                <div className="font-medium">
                  {t(opt.labelKey)}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t(opt.descKey)}
                </div>
              </div>
              {active && (
                <span className="text-xs font-medium text-primary">
                  {t("settings.sections.ingestStrategy.active")}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {config.lastClassification && (
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs font-semibold text-muted-foreground">
            {t("settings.sections.ingestStrategy.lastClassification")}
          </p>
          <p className="mt-1 text-sm">
            {t("settings.sections.ingestStrategy.classifiedAs", {
              strategy: config.lastClassification.strategy,
              confidence: Math.round(config.lastClassification.confidence * 100),
            })}
          </p>
          {config.lastClassification.reasoning.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              {config.lastClassification.reasoning.slice(0, 4).map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {saved && (
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.ingestStrategy.saved")}
        </p>
      )}
    </div>
  )
}

/**
 * Resolve the effective strategy for a document, combining the user's
 * config preference with the heuristic classifier. Returns the strategy
 * to apply plus the classification result (for logging / UI display).
 *
 * - If mode is explicitly set (not "auto"), returns that strategy
 *   directly with no classification.
 * - If mode is "auto", runs the heuristic classifier. When confidence
 *   >= threshold, applies the result. When confidence < threshold,
 *   returns the suggestion but flags `requiresUserConfirmation`.
 */
export function resolveIngestStrategy(
  content: string,
  config: IngestStrategyConfig,
): {
  strategy: IngestStrategy
  classification?: ClassificationResult
} {
  if (config.mode !== "auto") {
    return { strategy: config.mode }
  }

  const result = heuristicClassify(content)
  return {
    strategy: result.requiresUserConfirmation ? "fixed" : result.strategy,
    classification: result,
  }
}
