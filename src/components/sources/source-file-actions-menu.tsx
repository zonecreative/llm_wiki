import { useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  BookOpen,
  Link2,
  MoreHorizontal,
  RefreshCcw,
  RotateCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import type { FileNode } from "@/types/wiki"
import { useTranslation } from "react-i18next"

const MENU_WIDTH = 224
const MENU_HEIGHT_ESTIMATE = 176

interface MenuPosition {
  top: number
  left: number
}

interface SourceFileActionsMenuProps {
  node: FileNode
  open: boolean
  ingesting: boolean
  onToggle: (event: React.MouseEvent) => void
  onClose: () => void
  onIngest: (node: FileNode) => void
  onLinkRepair: (node: FileNode) => void
  onForceReingest: (node: FileNode) => void
  onCleanReingest: (node: FileNode) => void
  /** Compact sizing for narrow sidebars */
  compact?: boolean
}

function computeMenuPosition(anchor: HTMLElement): MenuPosition {
  const rect = anchor.getBoundingClientRect()
  const spaceBelow = window.innerHeight - rect.bottom
  const openUp = spaceBelow < MENU_HEIGHT_ESTIMATE + 8
  const top = openUp
    ? Math.max(8, rect.top - MENU_HEIGHT_ESTIMATE - 4)
    : rect.bottom + 4
  const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8))
  return { top, left }
}

export function SourceFileActionsMenu({
  node,
  open,
  ingesting,
  onToggle,
  onClose,
  onIngest,
  onLinkRepair,
  onForceReingest,
  onCleanReingest,
  compact = false,
}: SourceFileActionsMenuProps) {
  const { t } = useTranslation()
  const anchorRef = useRef<HTMLDivElement>(null)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setMenuPosition(null)
      return
    }
    const update = () => {
      if (!anchorRef.current) return
      setMenuPosition(computeMenuPosition(anchorRef.current))
    }
    update()
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [open])

  const run = (action: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation()
    onClose()
    action()
  }

  const buttonClass = compact
    ? "h-6 w-6 text-muted-foreground hover:text-primary"
    : "h-7 w-7 text-muted-foreground/70 hover:text-primary hover:bg-accent"

  const menu = open && menuPosition
    ? createPortal(
        <div
          className="fixed z-[200] w-56 rounded-md border bg-background py-1 text-xs shadow-lg"
          style={{ top: menuPosition.top, left: menuPosition.left }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent disabled:opacity-50"
            disabled={ingesting}
            onClick={run(() => onIngest(node))}
          >
            <BookOpen className="h-3.5 w-3.5 shrink-0" />
            <span>{t("sources.ingest")}</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
            onClick={run(() => onLinkRepair(node))}
          >
            <Link2 className="h-3.5 w-3.5 shrink-0" />
            <span>{t("sources.linkRepairTitle")}</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent disabled:opacity-50"
            disabled={ingesting}
            onClick={run(() => onForceReingest(node))}
          >
            <RotateCw className="h-3.5 w-3.5 shrink-0" />
            <span>{t("sources.forceReingestShort")}</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent disabled:opacity-50"
            disabled={ingesting}
            onClick={run(() => onCleanReingest(node))}
          >
            <RefreshCcw className="h-3.5 w-3.5 shrink-0" />
            <span>{t("sources.cleanReingestShort")}</span>
          </button>
        </div>,
        document.body,
      )
    : null

  return (
    <>
      <div ref={anchorRef} className="relative shrink-0" onPointerDown={(event) => event.stopPropagation()}>
        <Button
          variant="ghost"
          size="icon"
          className={buttonClass}
          title={t("sources.fileActionsMenu")}
          aria-expanded={open}
          aria-label={t("sources.fileActionsMenu")}
          onClick={onToggle}
        >
          <MoreHorizontal className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        </Button>
      </div>
      {menu}
    </>
  )
}
