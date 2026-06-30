import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { Plus, FileText, RefreshCw, BookOpen, Trash2, Folder, ChevronRight, ChevronDown, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory, readFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { useTranslation } from "react-i18next"
import { normalizePath } from "@/lib/path-utils"
import { decideDeleteClick } from "@/lib/sources-tree-delete"
import { rescanProjectFileSync } from "@/lib/project-file-sync"
import { naturalCompare } from "@/lib/natural-sort"
import {
  deleteSourceFile,
  deleteSourceFolder,
  enqueueSourceIngest,
  importSourceFiles,
  importSourceFolder,
  forceReingestSource,
  forceReingestAllSources,
} from "@/lib/source-lifecycle"
import { BatchIngestDialog } from "./batch-ingest-dialog"
import { filterRawSourceTree } from "@/lib/source-filter"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

const SOURCE_TREE_INITIAL_ROWS = 160
const SOURCE_TREE_LOAD_BATCH = 160

export function SourcesView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const openFileInPreview = useWikiStore((s) => s.openFileInPreview)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const sourceWatchConfig = useWikiStore((s) => s.sourceWatchConfig)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [sources, setSources] = useState<FileNode[]>([])
  const [importing, setImporting] = useState(false)
  const [ingestingPath, setIngestingPath] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  /**
   * Path of the source-tree node currently in "click again to
   * confirm delete" state. Lifted up here (rather than living
   * inside SourceTree) for two reasons:
   *   1. Only one button can be armed at a time across the whole
   *      tree — clicking another delete disarms the prior one.
   *      Lifting state to the common ancestor makes that natural.
   *   2. The auto-disarm timer (5s) needs to survive across re-
   *      renders triggered by tree mutation; useEffect cleanup
   *      anchored here is the right scope.
   */
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null)
  const [reingestingAll, setReingestingAll] = useState(false)
  const [showReingestAllConfirm, setShowReingestAllConfirm] = useState(false)
  const [showBatchDialog, setShowBatchDialog] = useState(false)

  // Auto-disarm: 5 seconds without a second click resets the
  // pending state. Prevents a stale armed button from firing if
  // the user walked away and came back. Cleared whenever the
  // pending path changes (so a fresh arm restarts the clock).
  useEffect(() => {
    if (!pendingDeletePath) return
    const t = setTimeout(() => setPendingDeletePath(null), 5000)
    return () => clearTimeout(t)
  }, [pendingDeletePath])

  const loadSources = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const tree = await listDirectory(`${pp}/raw/sources`, true)
      setSources(filterRawSourceTree(tree))
      setRefreshError(null)
    } catch (err) {
      setRefreshError(String(err))
      setSources([])
    }
  }, [project])

  useEffect(() => {
    loadSources()
  }, [loadSources, dataVersion])

  async function handleRefreshSources() {
    if (!project || refreshing) return
    setRefreshing(true)
    try {
      await rescanProjectFileSync(project, useWikiStore.getState().sourceWatchConfig)
      setRefreshError(null)
    } catch (err) {
      console.warn("[sources] failed to rescan project files:", err)
      setRefreshError(String(err))
    } finally {
      await loadSources()
      setRefreshing(false)
    }
  }

  async function handleImport() {
    if (!project) return

    const selected = await open({
      multiple: true,
      title: t("sources.importSourceFiles"),
      filters: [
        {
          name: "Documents",
          extensions: [
            "md", "mdx", "txt", "rtf", "pdf",
            "html", "htm", "xml",
            "doc", "docx", "xls", "xlsx", "ppt", "pptx",
            "odt", "ods", "odp", "epub", "pages", "numbers", "key",
          ],
        },
        {
          name: "Data",
          extensions: ["json", "jsonl", "csv", "tsv", "yaml", "yml", "ndjson"],
        },
        {
          name: "Code",
          extensions: [
            "py", "js", "ts", "jsx", "tsx", "rs", "go", "java",
            "c", "cpp", "h", "rb", "php", "swift", "sql", "sh",
          ],
        },
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "avif", "heic"],
        },
        {
          name: "Media",
          extensions: ["mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "m4a"],
        },
        { name: "All Files", extensions: ["*"] },
      ],
    })

    if (!selected || selected.length === 0) return

    setImporting(true)
    const paths = Array.isArray(selected) ? selected : [selected]
    try {
      await importSourceFiles(project, paths, llmConfig, sourceWatchConfig)
      await loadSources()
    } finally {
      setImporting(false)
    }
  }

  async function handleImportFolder() {
    if (!project) return

    const selected = await open({
      directory: true,
      title: t("sources.importSourceFolder"),
    })

    if (!selected || typeof selected !== "string") return

    setImporting(true)
    try {
      await importSourceFolder(project, selected, llmConfig, sourceWatchConfig)
      await loadSources()
    } catch (err) {
      console.error(`Failed to import folder:`, err)
    } finally {
      setImporting(false)
    }
  }

  async function handleOpenSource(node: FileNode) {
    try {
      const content = await readFile(node.path)
      openFileInPreview(node.path, content)
    } catch (err) {
      console.error("Failed to read source:", err)
    }
  }

  async function handleDelete(node: FileNode) {
    if (!project) return
    const pp = normalizePath(project.path)
    // Confirmation now lives in the SourceTree component as a
    // two-stage button (click once = "Confirm", click again =
    // delete). Reaching this handler means the user has already
    // confirmed via the inline UI, so we proceed unconditionally.
    try {
      const result = await deleteSourceFile(pp, node.path)
      // Step 8: Refresh everything (UI side — must run with parent
      // context, hence kept here rather than inside the helper).
      await loadSources()
      await refreshProjectFileTree(pp, {
        projectId: project.id,
        bumpDataVersion: true,
      })
      if (
        selectedFile === node.path ||
        result.deletedWikiPaths.includes(selectedFile ?? "")
      ) {
        setSelectedFile(null)
      }
    } catch (err) {
      console.error("Failed to delete source:", err)
      window.alert(`Failed to delete: ${err}`)
    }
  }

  /**
   * Recursive folder delete. Walks the folder tree, runs the
   * wiki-cascade for every individual file inside (so any
   * derived wiki pages, embeddings, log entries get cleaned up
   * the same way as a single-file delete), then removes the
   * folder itself with `deleteFile` — which dispatches to
   * `remove_dir_all` Rust-side, taking the now-empty (or near-
   * empty) directory tree with it including any leftover dotdir
   * cache files we didn't explicitly target.
   *
   * Errors on individual files are logged and skipped; the batch
   * keeps going so partial cleanup is preferred over an all-or-
   * nothing failure that leaves the tree half-deleted.
   */
  async function handleDeleteFolder(folder: FileNode) {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const result = await deleteSourceFolder(pp, folder)
      await loadSources()
      await refreshProjectFileTree(pp, {
        projectId: project.id,
        bumpDataVersion: true,
      })
      if (
        selectedFile?.startsWith(folder.path + "/") ||
        result.deletedWikiPaths.includes(selectedFile ?? "")
      ) {
        setSelectedFile(null)
      }
    } catch (err) {
      console.error("Failed to delete folder:", err)
      window.alert(`Failed to delete folder: ${err}`)
    }
  }

  async function handleIngest(node: FileNode) {
    if (!project || ingestingPath) return
    // Re-ingest goes through the same automated queue path as a fresh
    // import (`handleImport` above). Earlier this used `startIngest`,
    // which opens an interactive chat → user clicks "Save to Wiki" →
    // `executeIngestWrites`. That had two problems: (a) it duplicated
    // the auto-pipeline so features like image cascade had to be
    // wired in twice, and (b) the interactive flow surprised users
    // who expected a fresh-import re-run. One button, one path now.
    setIngestingPath(node.path)
    try {
      await enqueueSourceIngest(project, [node.path], llmConfig)
    } catch (err) {
      console.error("Failed to enqueue ingest:", err)
    } finally {
      setIngestingPath(null)
    }
  }

  async function handleForceReingest(node: FileNode) {
    if (!project || ingestingPath) return
    // Force re-ingest clears the cache entry for this source and
    // re-runs the full pipeline. Used when the user wants to apply
    // a new ingest strategy or re-process after a pipeline fix.
    setIngestingPath(node.path)
    try {
      await forceReingestSource(project, [node.path], llmConfig)
    } catch (err) {
      console.error("Failed to force re-ingest:", err)
    } finally {
      setIngestingPath(null)
    }
  }

  async function handleReingestAll() {
    if (!project || reingestingAll) return
    // The confirmation dialog was already shown by the caller; this
    // function runs after the user confirmed.
    setReingestingAll(true)
    try {
      await forceReingestAllSources(project, llmConfig)
    } catch (err) {
      console.error("Failed to re-ingest all sources:", err)
    } finally {
      setReingestingAll(false)
      setShowReingestAllConfirm(false)
    }
  }

  return (
    <TooltipProvider delay={300}>
      <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t("sources.title")}</h2>
        <div className="flex gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleRefreshSources}
                  disabled={refreshing}
                  aria-label={t("sources.refreshFolder")}
                />
              }
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" className="max-w-80 whitespace-normal leading-relaxed">
              {t("sources.refreshFolderTooltip")}
            </TooltipContent>
          </Tooltip>
          <Button size="sm" onClick={handleImport} disabled={importing}>
            <Plus className="mr-1 h-4 w-4" />
            {importing ? t("sources.importing") : t("sources.import")}
          </Button>
          <Button size="sm" onClick={handleImportFolder} disabled={importing}>
            <Plus className="mr-1 h-4 w-4" />
            {importing ? t("sources.importing") : t("sources.importFolder", "Folder")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowBatchDialog(true)}
            disabled={!project || sources.length === 0}
            className="text-xs"
            title={t("sources.batchIngestTooltip", { defaultValue: "Set strategy per file, then ingest all at once" })}
          >
            <RotateCw className="mr-1 h-3.5 w-3.5" />
            {t("sources.batchIngest", { defaultValue: "Batch Ingest" })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowBatchDialog(true)}
            disabled={!project || reingestingAll || sources.length === 0}
            className="text-xs"
            title={t("sources.batchIngestTooltip", { defaultValue: "Set strategy per file, then ingest all at once — no interruptions" })}
          >
            <RotateCw className={`mr-1 h-3.5 w-3.5 ${reingestingAll ? "animate-spin" : ""}`} />
            {reingestingAll
              ? t("sources.reingesting", { defaultValue: "Re-ingesting..." })
              : t("sources.batchIngest", { defaultValue: "Batch Ingest" })}
          </Button>
        </div>
      </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        {refreshError && (
          <div className="mx-4 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {t("sources.refreshFailed", {
              defaultValue: "Failed to refresh sources: {{error}}",
              error: refreshError,
            })}
          </div>
        )}
        {sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
            <p>{t("sources.noSources")}</p>
            <p>{t("sources.importHint")}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleImport}>
                <Plus className="mr-1 h-4 w-4" />
                {t("sources.importFiles")}
              </Button>
              <Button variant="outline" size="sm" onClick={handleImportFolder}>
                <Plus className="mr-1 h-4 w-4" />
                {t("sources.importFolder")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-2">
            <SourceTree
              nodes={sources}
              onOpen={handleOpenSource}
              onIngest={handleIngest}
              onForceReingest={handleForceReingest}
              onDelete={handleDelete}
              onDeleteFolder={handleDeleteFolder}
              pendingDeletePath={pendingDeletePath}
              setPendingDeletePath={setPendingDeletePath}
              ingestingPath={ingestingPath}
            />
          </div>
        )}
      </ScrollArea>

      <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
        <span>{t("sources.sourceCount", { count: countFiles(sources) })}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefreshSources}
                disabled={!project || refreshing}
                className="h-7 px-2 text-xs"
              />
            }
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? t("sources.refreshingFolder") : t("sources.refreshFolder")}
          </TooltipTrigger>
          <TooltipContent side="top" align="end" className="max-w-80 whitespace-normal leading-relaxed">
            {t("sources.refreshFolderTooltip")}
          </TooltipContent>
        </Tooltip>
      </div>

      <BatchIngestDialog
        open={showBatchDialog}
        onClose={() => setShowBatchDialog(false)}
      />

      {showReingestAllConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowReingestAllConfirm(false)}
        >
          <div
            className="mx-4 max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2">
              <RotateCw className="h-5 w-5 text-primary" />
              <h3 className="text-lg font-semibold">
                {t("sources.reingestAllTitle", { defaultValue: "Re-ingest All Sources" })}
              </h3>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {t("sources.reingestAllConfirm", {
                defaultValue:
                  "This will clear the ingest cache for ALL source files and re-run the full ingest pipeline. " +
                  "This may take a long time and will use LLM tokens for every file. " +
                  "Wiki pages will be merged with existing content. Continue?",
              })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowReingestAllConfirm(false)}>
                {t("sources.cancel", { defaultValue: "Cancel" })}
              </Button>
              <Button
                onClick={handleReingestAll}
                disabled={reingestingAll}
              >
                {reingestingAll ? (
                  <>
                    <RotateCw className="mr-1.5 h-4 w-4 animate-spin" />
                    {t("sources.reingesting", { defaultValue: "Re-ingesting..." })}
                  </>
                ) : (
                  <>
                    <RotateCw className="mr-1.5 h-4 w-4" />
                    {t("sources.reingestAll", { defaultValue: "Re-ingest All" })}
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </TooltipProvider>
  )
}

interface SourceTreeRow {
  node: FileNode
  depth: number
}

function countFiles(nodes: FileNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      count += countFiles(node.children)
    } else if (!node.is_dir) {
      count++
    }
  }
  return count
}

function sortSourceNodes(nodes: readonly FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1
    if (!a.is_dir && b.is_dir) return 1
    return naturalCompare(a.name, b.name)
  })
}

function flattenVisibleRows(
  nodes: readonly FileNode[],
  collapsed: Record<string, boolean>,
  depth = 0,
): SourceTreeRow[] {
  const rows: SourceTreeRow[] = []
  for (const node of sortSourceNodes(nodes)) {
    rows.push({ node, depth })
    if (node.is_dir && node.children && !(collapsed[node.path] ?? false)) {
      rows.push(...flattenVisibleRows(node.children, collapsed, depth + 1))
    }
  }
  return rows
}

function SourceTree({
  nodes,
  onOpen,
  onIngest,
  onForceReingest,
  onDelete,
  onDeleteFolder,
  pendingDeletePath,
  setPendingDeletePath,
  ingestingPath,
}: {
  nodes: FileNode[]
  onOpen: (node: FileNode) => void
  onIngest: (node: FileNode) => void
  onForceReingest: (node: FileNode) => void
  onDelete: (node: FileNode) => void
  onDeleteFolder: (node: FileNode) => void
  /** Path of the node currently in "click again to confirm" state.
   *  Lifted to the parent so only ONE button is armed at a time
   *  across the whole tree — clicking another delete arms that one
   *  and disarms the previous. */
  pendingDeletePath: string | null
  setPendingDeletePath: (path: string | null) => void
  ingestingPath: string | null
}) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [visibleLimit, setVisibleLimit] = useState(SOURCE_TREE_INITIAL_ROWS)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const rows = useMemo(() => flattenVisibleRows(nodes, collapsed), [nodes, collapsed])
  const visibleRows = rows.slice(0, visibleLimit)
  const hasMore = visibleLimit < rows.length

  useEffect(() => {
    setVisibleLimit(SOURCE_TREE_INITIAL_ROWS)
  }, [nodes])

  useEffect(() => {
    if (!hasMore) return
    const target = loadMoreRef.current
    if (!target) return

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setVisibleLimit((current) => Math.min(current + SOURCE_TREE_LOAD_BATCH, rows.length))
    }, { rootMargin: "240px 0px" })

    observer.observe(target)
    return () => observer.disconnect()
  }, [hasMore, rows.length])

  const toggle = (path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  /**
   * Two-stage delete handler. Decision logic lives in
   * `decideDeleteClick` (pure, unit-tested in
   * `sources-tree-delete.test.ts`); this wrapper just dispatches
   * the resulting action onto the React state + handler props.
   */
  const handleDeleteClick = (node: FileNode) => {
    const action = decideDeleteClick(pendingDeletePath, node)
    switch (action.kind) {
      case "arm":
        setPendingDeletePath(action.path)
        return
      case "fire-file":
        setPendingDeletePath(null)
        onDelete(action.node)
        return
      case "fire-folder":
        setPendingDeletePath(null)
        onDeleteFolder(action.node)
        return
    }
  }

  return (
    <>
      {visibleRows.map(({ node, depth }) => {
        const isPendingDelete = pendingDeletePath === node.path
        if (node.is_dir && node.children) {
          const isCollapsed = collapsed[node.path] ?? false
          return (
            <div key={node.path}>
              <div
                className="group flex w-full items-center gap-1 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                style={{ paddingLeft: `${depth * 16 + 4}px` }}
              >
                <button
                  onClick={() => toggle(node.path)}
                  className="flex flex-1 items-center gap-1.5 px-1 py-1 text-left"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                  <span className="truncate font-medium">{node.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/60 shrink-0">
                    {countFiles(node.children)}
                  </span>
                </button>
                <DeleteButton
                  isPending={isPendingDelete}
                  onClick={() => handleDeleteClick(node)}
                  hint={
                    isPendingDelete
                      ? t("sources.deleteFolderConfirm", { name: node.name })
                      : t("sources.deleteFolder", { name: node.name })
                  }
                />
              </div>
            </div>
          )
        }

        return (
          <div
            key={node.path}
            className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
          >
            <button
              onClick={() => onOpen(node)}
              className="flex flex-1 items-center gap-2 truncate px-2 py-1 text-left"
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground/70 hover:text-primary hover:bg-accent"
              title={t("sources.ingest")}
              disabled={ingestingPath === node.path}
              onClick={() => onIngest(node)}
            >
              <BookOpen className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground/70 hover:text-primary hover:bg-accent"
              title={t("sources.forceReingest", { defaultValue: "Force Re-ingest (clear cache + re-run)" })}
              disabled={ingestingPath === node.path}
              onClick={() => onForceReingest(node)}
            >
              <RotateCw className="h-4 w-4" />
            </Button>
            <DeleteButton
              isPending={isPendingDelete}
              onClick={() => handleDeleteClick(node)}
              hint={
                isPendingDelete
                  ? t("sources.deleteFileConfirm", { name: node.name })
                  : t("sources.deleteFile", { name: node.name })
              }
            />
          </div>
        )
      })}
      {hasMore && (
        <div
          ref={loadMoreRef}
          className="px-3 py-2 text-center text-[11px] text-muted-foreground"
        >
          {t("sources.loadingMore")}
        </div>
      )}
    </>
  )
}

/**
 * Two-stage delete button. Default = ghost trash icon (subtle).
 * Armed = solid red "Confirm" pill with the icon — visually
 * unmistakable, so the user can't miss the second-click warning.
 *
 * Same component is used for both files and folders; the parent
 * decides which delete handler to call from the click. The pending
 * state is owned by SourceTree (lifted to its parent SourcesView)
 * so only one button is armed across the entire tree at a time.
 */
function DeleteButton({
  isPending,
  onClick,
  hint,
}: {
  isPending: boolean
  onClick: () => void
  hint: string
}) {
  const { t } = useTranslation()
  if (isPending) {
    return (
      <Button
        variant="destructive"
        size="sm"
        className="h-7 shrink-0 px-2 text-[11px] font-semibold animate-pulse"
        title={hint}
        onClick={onClick}
      >
        <Trash2 className="mr-1 h-3.5 w-3.5" />
        {t("sources.confirm")}
      </Button>
    )
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
      title={hint}
      onClick={onClick}
    >
      <Trash2 className="h-3.5 w-3.5" />
    </Button>
  )
}
