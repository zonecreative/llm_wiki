/**
 * Watches the store for pending watch-folder ingest files and shows
 * the Batch Ingest Dialog automatically. When the watch folder
 * detects new/modified files, it sets `pendingWatchIngest` instead
 * of enqueuing directly — this component bridges that to the dialog.
 *
 * The user sets strategies per file, clicks "Start Batch Ingest",
 * and the dialog enqueues everything with the correct overrides.
 */
import { useEffect, useState } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { BatchIngestDialog } from "@/components/sources/batch-ingest-dialog"

export function WatchIngestBridge() {
  const pendingWatchIngest = useWikiStore((s) => s.pendingWatchIngest)
  const setPendingWatchIngest = useWikiStore((s) => s.setPendingWatchIngest)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    if (pendingWatchIngest && pendingWatchIngest.length > 0) {
      setDialogOpen(true)
    }
  }, [pendingWatchIngest])

  const handleClose = () => {
    setDialogOpen(false)
    // Clear the pending list so the dialog doesn't reopen.
    // If the user cancelled, the files remain on disk but are
    // not enqueued — they can manually ingest later.
    setPendingWatchIngest(null)
  }

  return (
    <BatchIngestDialog
      open={dialogOpen}
      onClose={handleClose}
    />
  )
}
