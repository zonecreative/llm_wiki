import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { normalizeFileOverride } from "@/lib/ingest-strategy-resolver"
import {
  applyLinkRepair,
  findEncyclopediaPagesForSource,
  loadOriginalContentsForPlan,
  planLinkRepair,
  searchWikiPages,
  type LinkRepairMode,
  type LinkRepairPlan,
} from "@/lib/link-repair"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

interface Props {
  open: boolean
  onClose: () => void
  sourcePath: string
  sourceName: string
}

const MODES: LinkRepairMode[] = ["hub", "hierarchy", "custom"]

export function LinkRepairDialog({ open, onClose, sourcePath, sourceName }: Props) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const ingestStrategyConfig = useWikiStore((s) => s.ingestStrategyConfig)

  const [mode, setMode] = useState<LinkRepairMode>("hub")
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<LinkRepairPlan | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [pageCount, setPageCount] = useState(0)
  const [targetQuery, setTargetQuery] = useState("")
  const [targetSlug, setTargetSlug] = useState("")
  const [targetSuggestions, setTargetSuggestions] = useState<
    Array<{ slug: string; title: string; relativePath: string }>
  >([])
  const [applyResult, setApplyResult] = useState<{ modified: number; backupDir: string } | null>(null)

  const fileOverride = useMemo(
    () => normalizeFileOverride(ingestStrategyConfig.fileOverrides?.[sourceName]),
    [ingestStrategyConfig.fileOverrides, sourceName],
  )

  const slugMode = fileOverride?.slugMode ?? "default"
  const slugNamespace = fileOverride?.slugNamespace ?? ""

  const refreshPlan = useCallback(async () => {
    if (!project || !open) return
    setLoading(true)
    setError(null)
    setApplyResult(null)
    try {
      const pages = await findEncyclopediaPagesForSource(project.path, sourcePath)
      setPageCount(pages.length)
      if (pages.length === 0) {
        setPlan(null)
        setSelectedPaths(new Set())
        return
      }

      const nextPlan = await planLinkRepair({
        projectPath: project.path,
        sourcePath,
        mode,
        targetSlug: mode === "custom" ? targetSlug : undefined,
        slugMode,
        slugNamespace,
      })
      setPlan(nextPlan)
      setSelectedPaths(new Set(
        nextPlan.items
          .filter((item) => !item.alreadyLinked && item.newContent)
          .map((item) => item.relativePath),
      ))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPlan(null)
    } finally {
      setLoading(false)
    }
  }, [project, open, sourcePath, mode, targetSlug, slugMode, slugNamespace])

  useEffect(() => {
    if (!open) {
      setMode("hub")
      setPlan(null)
      setSelectedPaths(new Set())
      setError(null)
      setApplyResult(null)
      setTargetQuery("")
      setTargetSlug("")
      setTargetSuggestions([])
      return
    }
    void refreshPlan()
  }, [open, mode, targetSlug, refreshPlan])

  useEffect(() => {
    if (!project || mode !== "custom" || targetQuery.trim().length < 2) {
      setTargetSuggestions([])
      return
    }
    const timer = setTimeout(() => {
      void searchWikiPages(project.path, targetQuery, 12).then(setTargetSuggestions)
    }, 200)
    return () => clearTimeout(timer)
  }, [project, mode, targetQuery])

  const togglePath = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectAll = () => {
    if (!plan) return
    setSelectedPaths(new Set(plan.items.map((item) => item.relativePath)))
  }

  const selectUnlinked = () => {
    if (!plan) return
    setSelectedPaths(new Set(
      plan.items.filter((item) => !item.alreadyLinked).map((item) => item.relativePath),
    ))
  }

  const pagesToModify = useMemo(() => {
    if (!plan) return 0
    return plan.items.filter(
      (item) => selectedPaths.has(item.relativePath) && item.newContent,
    ).length
  }, [plan, selectedPaths])

  const previewLines = useMemo(() => {
    if (!plan) return []
    return plan.items
      .filter((item) => selectedPaths.has(item.relativePath) && item.newContent)
      .slice(0, 10)
      .map((item) => `${item.pageTitle} → [[${item.targetSlug}]] (${item.action})`)
  }, [plan, selectedPaths])

  async function handleApply() {
    if (!project || !plan || pagesToModify === 0) return
    setApplying(true)
    setError(null)
    try {
      const planWithSelection: LinkRepairPlan = {
        ...plan,
        items: plan.items.map((item) => ({
          ...item,
          selected: selectedPaths.has(item.relativePath),
        })),
        pagesToModify,
        previewLines,
      }
      const originals = await loadOriginalContentsForPlan(project.path, planWithSelection)
      const result = await applyLinkRepair(project.path, planWithSelection, originals)
      setApplyResult({ modified: result.modified, backupDir: result.backupDir })
      await refreshProjectFileTree(normalizePath(project.path), { bumpDataVersion: true })
      await refreshPlan()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[760px] flex-col rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">{t("sources.linkRepairTitle")}</h2>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="border-b px-5 py-2 text-sm text-muted-foreground">
          {sourceName} · {t("sources.linkRepairPageCount", { count: pageCount })}
        </div>

        <div className="flex gap-1 border-b px-5 py-2">
          {MODES.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`rounded px-3 py-1 text-xs ${mode === tab ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
              onClick={() => setMode(tab)}
            >
              {t(`sources.linkRepairTab${tab.charAt(0).toUpperCase()}${tab.slice(1)}`)}
            </button>
          ))}
        </div>

        {mode === "custom" && (
          <div className="space-y-2 border-b px-5 py-3">
            <label className="text-xs text-muted-foreground">{t("sources.linkRepairTargetLabel")}</label>
            <input
              type="text"
              value={targetQuery}
              onChange={(e) => setTargetQuery(e.target.value)}
              placeholder={t("sources.linkRepairSearchPlaceholder")}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {targetSuggestions.length > 0 && (
              <div className="max-h-32 overflow-y-auto rounded border text-xs">
                {targetSuggestions.map((suggestion) => (
                  <button
                    key={suggestion.relativePath}
                    type="button"
                    className={`block w-full px-2 py-1 text-left hover:bg-accent ${targetSlug === suggestion.slug ? "bg-accent" : ""}`}
                    onClick={() => {
                      setTargetSlug(suggestion.slug)
                      setTargetQuery(suggestion.title)
                      setTargetSuggestions([])
                    }}
                  >
                    {suggestion.title}
                    <span className="ml-2 text-muted-foreground">{suggestion.slug}</span>
                  </button>
                ))}
              </div>
            )}
            {targetSlug && (
              <p className="text-xs text-muted-foreground">
                {t("sources.linkRepairSelectedTarget", { slug: targetSlug })}
              </p>
            )}
          </div>
        )}

        {mode === "hub" && plan?.hubSlug && (
          <div className="border-b px-5 py-2 text-xs text-muted-foreground">
            {t("sources.linkRepairHubSlug", { slug: plan.hubSlug })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2 text-xs">
          <button type="button" className="rounded border px-2 py-0.5 hover:bg-accent" onClick={selectAll}>
            {t("sources.linkRepairSelectAll")}
          </button>
          <button type="button" className="rounded border px-2 py-0.5 hover:bg-accent" onClick={selectUnlinked}>
            {t("sources.linkRepairSelectUnlinked")}
          </button>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="px-5 py-2">
            {loading && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("sources.linkRepairPlanning")}
              </p>
            )}
            {error && (
              <p className="py-4 text-center text-sm text-destructive">{error}</p>
            )}
            {!loading && !error && pageCount === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("sources.linkRepairNoPages")}
              </p>
            )}
            {!loading && plan && plan.items.length > 0 && (
              <div className="space-y-1">
                {plan.items.map((item) => (
                  <label
                    key={item.relativePath}
                    className="flex items-center gap-2 border-b border-border/50 py-1.5 text-sm last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked={selectedPaths.has(item.relativePath)}
                      onChange={() => togglePath(item.relativePath)}
                      disabled={!item.newContent}
                    />
                    <span className="flex-1 truncate" title={item.relativePath}>
                      {item.pageTitle}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {item.alreadyLinked
                        ? t("sources.linkRepairAlreadyLinked")
                        : item.newContent
                          ? t("sources.linkRepairWillLink", { target: item.targetSlug })
                          : t("sources.linkRepairNoChange")}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="space-y-2 border-t px-5 py-3">
          {previewLines.length > 0 && (
            <div className="rounded border bg-muted/30 px-3 py-2 text-xs">
              <p className="font-medium">{t("sources.linkRepairPreview", { count: pagesToModify })}</p>
              <ul className="mt-1 list-inside list-disc text-muted-foreground">
                {previewLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {applyResult && (
            <p className="text-xs text-muted-foreground">
              {t("sources.linkRepairDone", { count: applyResult.modified })}
              {" · "}
              {t("sources.linkRepairBackupPath", { path: applyResult.backupDir })}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={applying}>
              {t("sources.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              onClick={handleApply}
              disabled={applying || loading || !plan || pagesToModify === 0}
            >
              {applying ? t("sources.linkRepairApplying") : t("sources.linkRepairApply")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
