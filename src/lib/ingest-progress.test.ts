import { describe, it, expect, beforeEach } from "vitest"
import i18n from "@/i18n"
import {
  announceIngestPlan,
  setIngestStep,
  ingestStep2,
  addIngestWarning,
  clearIngestProgress,
  formatIngestDoneDetail,
  ingestWriteWarnings,
  ingestMineruParsing,
} from "@/lib/ingest-progress"
import { useActivityStore } from "@/stores/activity-store"

describe("ingest-progress", () => {
  beforeEach(() => {
    i18n.changeLanguage("en")
    useActivityStore.setState({ items: [] })
  })

  it("shows plan and step on separate lines", () => {
    const id = useActivityStore.getState().addItem({
      type: "ingest",
      title: "test.md",
      status: "running",
      detail: "",
      filesWritten: [],
    })
    announceIngestPlan(id, {
      strategy: "tabular",
      source: "classifier",
      confidence: 0.95,
      tabularRows: 188,
      tabularBatches: 8,
    })
    ingestStep2(id)
    const item = useActivityStore.getState().items.find((i) => i.id === id)
    expect(item?.detail).toContain("Strategy: Tabular glossary")
    expect(item?.detail).toContain("188 glossary rows in 8 batch(es)")
    expect(item?.detail).toContain("Step 2/2: Generating wiki pages...")
    clearIngestProgress(id)
  })

  it("persists warnings across step updates", () => {
    const id = useActivityStore.getState().addItem({
      type: "ingest",
      title: "test.md",
      status: "running",
      detail: "",
      filesWritten: [],
    })
    setIngestStep(id, "Writing files...")
    addIngestWarning(id, "Source summary has only 1 body wikilinks (need 3)")
    setIngestStep(id, "Done")
    const item = useActivityStore.getState().items.find((i) => i.id === id)
    expect(item?.detail).toContain("⚠")
    expect(item?.detail).toContain("wikilinks")
    clearIngestProgress(id)
  })

  it("formatIngestDoneDetail includes persisted warnings", () => {
    const id = useActivityStore.getState().addItem({
      type: "ingest",
      title: "test.md",
      status: "running",
      detail: "",
      filesWritten: [],
    })
    addIngestWarning(id, "Encyclopedia coverage 80% — missing: foo")
    const detail = formatIngestDoneDetail(10, 2, undefined, id)
    expect(detail).toContain("10 files written")
    expect(detail).toContain("⚠")
    clearIngestProgress(id)
  })

  it("ingestWriteWarnings adds capped warnings to activity panel", () => {
    const id = useActivityStore.getState().addItem({
      type: "ingest",
      title: "test.md",
      status: "running",
      detail: "",
      filesWritten: [],
    })
    ingestMineruParsing(id)
    const summary = ingestWriteWarnings(id, ["drop A", "drop B", "drop C", "drop D"])
    expect(summary).toContain("4 ingest warnings")
    const item = useActivityStore.getState().items.find((i) => i.id === id)
    expect(item?.detail).toContain("⚠ drop A")
    expect(item?.detail).toContain("+1 more warnings")
    clearIngestProgress(id)
  })
})
