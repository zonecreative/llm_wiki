/**
 * Batch ingest dialog with per-file strategy selection.
 *
 * Shows all source files in a list, each with a strategy dropdown
 * (Auto / Encyclopedia / Narrative / Fixed). The user can set
 * strategies for all files upfront, then click "Start Ingest" to
 * queue them all — no more monitoring needed for the classification
 * dialog to pop up mid-batch.
 *
 * The selected strategies are stored as per-file overrides in
 * ingestStrategyConfig.fileOverrides, which autoIngest checks
 * before running the classifier.
 */
import { useState, useEffect, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { RotateCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { forceReingestSource } from "@/lib/source-lifecycle"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { heuristicClassify } from "@/lib/document-classifier"
import type { IngestStrategy } from "@/types/ingest"
import { collectAllFilesIncludingDot } from "@/lib/sources-tree-delete"
import type { FileNode } from "@/types/wiki"

interface BatchFileEntry {
  path: string
  name: string
  strategy: IngestStrategy | "auto"
  suggested?: IngestStrategy
  confidence?: number
}

interface Props {
  open: boolean
  onClose: () => void
}

const STRATEGY_LABELS: Record<IngestStrategy | "auto", string> = {
  auto: "Auto",
  encyclopedia: "Encyclopedia",
  narrative: "Narrative",
  fixed: "Fixed",
  mixed: "Mixed",
}

const STRATEGY_DESCRIPTIONS: Record<IngestStrategy | "auto", string> = {
  auto: "Auto-classify each file using the heuristic classifier. Asks for confirmation when confidence is low.",
  encyclopedia: "Each heading becomes a wiki page. Best for compendiums, manuals, glossaries, bestiaries, spell lists. Structural headings (repeated across entries) are folded into their parent.",
  narrative: "Headings are chapter boundaries, not entities. Extracts characters, places, events from prose. Best for novels, stories, screenplays. Does NOT create pages for chapters.",
  fixed: "Legacy token-window chunking. The LLM decides freely what to extract. Best for essays, articles, academic papers, blog posts, and any document where headings are argumentative (sections of a discourse), not definitional (entries of a reference).",
  mixed: "Document has both encyclopedic and narrative sections. Each H1 section is classified separately. (Future work — not yet implemented.)",
}

export function BatchIngestDialog({ open, onClose }: Props) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const ingestStrategyConfig = useWikiStore((s) => s.ingestStrategyConfig)
  const setIngestStrategyConfig = useWikiStore((s) => s.setIngestStrategyConfig)
  const pendingWatchIngest = useWikiStore((s) => s.pendingWatchIngest)

  const [files, setFiles] = useState<BatchFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [ingesting, setIngesting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load source files when dialog opens
  const loadFiles = useCallback(async () => {
    if (!project) return
    setLoading(true)
    setError(null)
    try {
      const pp = normalizePath(project.path)

      let allFiles: { path: string; name: string }[]

      if (pendingWatchIngest && pendingWatchIngest.length > 0) {
        // Watch folder detected new files — use those paths directly
        allFiles = pendingWatchIngest.map((path) => {
          const parts = path.split("/")
          return { path: `${pp}/${path}`, name: parts[parts.length - 1] }
        })
      } else {
        // Manual batch from Sources view — load all files from raw/sources
        const tree = await listDirectory(`${pp}/raw/sources`)
        const nodes: FileNode[] = []
        for (const node of tree) {
          for (const f of collectAllFilesIncludingDot(node)) {
            nodes.push(f)
          }
        }
        allFiles = nodes.map((f) => ({ path: f.path, name: f.name }))
      }

      // For each file, run a quick heuristic classification to
      // pre-fill the suggested strategy (but default to "auto" so
      // the user can accept or override).
      const entries: BatchFileEntry[] = []
      for (const file of allFiles) {
        const fileName = file.name
        const existingOverride = ingestStrategyConfig.fileOverrides?.[fileName]

        // Default: use existing override if present, else "auto"
        let strategy: IngestStrategy | "auto" = existingOverride ?? "auto"
        let suggested: IngestStrategy | undefined
        let confidence: number | undefined

        // If no override and mode is auto, pre-classify to show a suggestion
        if (!existingOverride && ingestStrategyConfig.mode === "auto") {
          try {
            const { readFile } = await import("@/commands/fs")
            const content = await readFile(file.path, { extractImages: false })
            const result = heuristicClassify(content)
            suggested = result.strategy
            confidence = result.confidence
          } catch {
            // Can't read file — leave suggestion undefined
          }
        }

        entries.push({ path: file.path, name: fileName, strategy, suggested, confidence })
      }

      setFiles(entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [project, ingestStrategyConfig, pendingWatchIngest])

  useEffect(() => {
    if (open) loadFiles()
  }, [open, loadFiles])

  // Update strategy for a single file
  const updateStrategy = (fileName: string, strategy: IngestStrategy | "auto") => {
    setFiles((prev) =>
      prev.map((f) => (f.name === fileName ? { ...f, strategy } : f)),
    )
  }

  // Bulk-apply a strategy to all files
  const applyToAll = (strategy: IngestStrategy | "auto") => {
    setFiles((prev) => prev.map((f) => ({ ...f, strategy })))
  }

  // Accept all suggestions
  const acceptAllSuggestions = () => {
    setFiles((prev) =>
      prev.map((f) => ({
        ...f,
        strategy: f.suggested ?? f.strategy,
      })),
    )
  }

  // Start the batch ingest
  const handleStartIngest = async () => {
    if (!project || !hasUsableLlm(llmConfig)) return

    // Save per-file overrides to the store
    const overrides: Record<string, IngestStrategy> = {}
    for (const f of files) {
      if (f.strategy !== "auto") {
        overrides[f.name] = f.strategy
      }
    }

    setIngestStrategyConfig({
      ...ingestStrategyConfig,
      fileOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    })

    // Persist the config
    try {
      const { saveIngestStrategyConfig } = await import("@/lib/project-store")
      await saveIngestStrategyConfig({
        ...ingestStrategyConfig,
        fileOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      })
    } catch (err) {
      console.warn("[batch-ingest] failed to save config:", err)
    }

    setIngesting(true)
    try {
      const filePaths = files.map((f) => f.path)
      await forceReingestSource(project, filePaths, llmConfig)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIngesting(false)
      // Clear the pending watch ingest so the dialog doesn't reopen
      useWikiStore.getState().setPendingWatchIngest(null)
      onClose()
    }
  }

  if (!open) return null

  const llmReady = hasUsableLlm(llmConfig)
  const hasSuggestions = files.some((f) => f.suggested !== undefined)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[600px] flex-col rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <RotateCw className={`h-5 w-5 text-primary ${ingesting ? "animate-spin" : ""}`} />
            <h2 className="text-lg font-semibold">
              {t("sources.batchIngestTitle", { defaultValue: "Batch Ingest — Set Strategy per File" })}
            </h2>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Bulk actions */}
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2 text-xs">
          <span className="text-muted-foreground">Apply to all:</span>
          <button
            className="rounded border px-2 py-0.5 hover:bg-accent"
            title={STRATEGY_DESCRIPTIONS.auto}
            onClick={() => applyToAll("auto")}
          >
            Auto
          </button>
          <button
            className="rounded border px-2 py-0.5 hover:bg-accent"
            title={STRATEGY_DESCRIPTIONS.encyclopedia}
            onClick={() => applyToAll("encyclopedia")}
          >
            Encyclopedia
          </button>
          <button
            className="rounded border px-2 py-0.5 hover:bg-accent"
            title={STRATEGY_DESCRIPTIONS.narrative}
            onClick={() => applyToAll("narrative")}
          >
            Narrative
          </button>
          <button
            className="rounded border px-2 py-0.5 hover:bg-accent"
            title={STRATEGY_DESCRIPTIONS.fixed}
            onClick={() => applyToAll("fixed")}
          >
            Fixed
          </button>
          {hasSuggestions && (
            <button
              className="ml-auto rounded border border-primary/50 px-2 py-0.5 text-primary hover:bg-primary/5"
              onClick={acceptAllSuggestions}
            >
              Accept all suggestions
            </button>
          )}
        </div>

        {/* Strategy guide */}
        <div className="border-b bg-muted/30 px-5 py-2 text-[11px] text-muted-foreground">
          <div><strong>Encyclopedia:</strong> compendi, manuali, glossari, bestiari, elenchi magie/armi — una pagina per voce</div>
          <div><strong>Narrative:</strong> romanzi, racconti, sceneggiature — estrae personaggi/luoghi/eventi, niente pagine capitolo</div>
          <div><strong>Fixed:</strong> saggi, articoli, paper, blog — il LLM decide liberamente cosa estrarre</div>
        </div>

        {/* File list */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-5 py-2">
            {loading && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Loading source files...
              </div>
            )}
            {error && (
              <div className="py-4 text-center text-sm text-destructive">
                {error}
              </div>
            )}
            {!loading && !error && files.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No source files found. Import files first.
              </div>
            )}
            {!loading && !error && files.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-3 border-b border-border/50 py-2 last:border-0"
              >
                <span className="flex-1 truncate text-sm" title={file.path}>
                  {file.name}
                </span>
                {file.suggested && file.strategy === "auto" && (
                  <span className="text-xs text-muted-foreground" title={`Heuristic suggestion: ${file.suggested} (${Math.round((file.confidence ?? 0) * 100)}% confidence)`}>
                    suggested: {STRATEGY_LABELS[file.suggested]}
                  </span>
                )}
                <select
                  value={file.strategy}
                  onChange={(e) => updateStrategy(file.name, e.target.value as IngestStrategy | "auto")}
                  title={STRATEGY_DESCRIPTIONS[file.strategy]}
                  className="w-36 rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="auto">Auto</option>
                  <option value="encyclopedia">Encyclopedia</option>
                  <option value="narrative">Narrative</option>
                  <option value="fixed">Fixed</option>
                </select>
              </div>
            ))}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {files.length} file(s) · {files.filter((f) => f.strategy !== "auto").length} with override
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={ingesting}>
              Cancel
            </Button>
            <Button
              onClick={handleStartIngest}
              disabled={ingesting || loading || files.length === 0 || !llmReady}
            >
              {ingesting ? (
                <>
                  <RotateCw className="mr-1.5 h-4 w-4 animate-spin" />
                  Ingesting...
                </>
              ) : (
                <>
                  <RotateCw className="mr-1.5 h-4 w-4" />
                  Start Batch Ingest
                </>
              )}
            </Button>
          </div>
        </div>

        {!llmReady && (
          <div className="border-t bg-destructive/10 px-5 py-2 text-xs text-destructive">
            No LLM configured. Go to Settings → LLM Models to set up a provider.
          </div>
        )}
      </div>
    </div>
  )
}
