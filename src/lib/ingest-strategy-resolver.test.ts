import { describe, it, expect, vi, afterEach } from "vitest"
import {
  resolveIngestStrategy,
  normalizeFileOverride,
} from "@/lib/ingest-strategy-resolver"
import { CLASSIFIER_CONFIDENCE_THRESHOLD } from "@/types/ingest"
import * as documentClassifier from "@/lib/document-classifier"
import { readFileSync } from "fs"
import { join } from "path"

const FIXTURES_DIR = join(__dirname, "..", "test-helpers", "fixtures", "ingest-strategy")

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8")
}

describe("normalizeFileOverride", () => {
  it("passes through object overrides", () => {
    expect(normalizeFileOverride({ strategy: "narrative", slugMode: "default" })).toEqual({
      strategy: "narrative",
      slugMode: "default",
    })
  })

  it("wraps legacy string overrides", () => {
    expect(normalizeFileOverride("encyclopedia")).toEqual({ strategy: "encyclopedia" })
  })
})

describe("resolveIngestStrategy — forced mode", () => {
  it("returns forced mode without classification", () => {
    const result = resolveIngestStrategy({
      content: "anything",
      config: { mode: "narrative" },
    })
    expect(result.strategy).toBe("narrative")
    expect(result.source).toBe("forced-mode")
    expect(result.classification).toBeUndefined()
    expect(result.requiresUserPrompt).toBe(false)
  })
})

describe("resolveIngestStrategy — file override", () => {
  it("skips classifier when file override is set", () => {
    const result = resolveIngestStrategy({
      content: loadFixture("romanzo-soeliok.md"),
      config: {
        mode: "auto",
        fileOverrides: { "romanzo-soeliok.md": { strategy: "fixed" } },
      },
      fileName: "romanzo-soeliok.md",
    })
    expect(result.strategy).toBe("fixed")
    expect(result.source).toBe("file-override")
    expect(result.classification).toBeUndefined()
  })
})

describe("resolveIngestStrategy — auto high confidence", () => {
  it("classifies compendio as encyclopedia", () => {
    const result = resolveIngestStrategy({
      content: loadFixture("compendio-nani.md"),
      config: { mode: "auto" },
    })
    expect(result.strategy).toBe("encyclopedia")
    expect(result.source).toBe("classifier")
    expect(result.classification!.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD)
    expect(result.requiresUserPrompt).toBe(false)
  })

  it("classifies romanzo as narrative", () => {
    const result = resolveIngestStrategy({
      content: loadFixture("romanzo-soeliok.md"),
      config: { mode: "auto" },
    })
    expect(result.strategy).toBe("narrative")
    expect(result.source).toBe("classifier")
    expect(result.requiresUserPrompt).toBe(false)
  })
})

describe("resolveIngestStrategy — low confidence", () => {
  const lowConfidenceContent = ""

  it("flags user prompt in interactive context", () => {
    const result = resolveIngestStrategy({
      content: lowConfidenceContent,
      config: { mode: "auto" },
      interactive: true,
    })
    expect(result.requiresUserPrompt).toBe(true)
    expect(result.classification).toBeDefined()
    expect(result.classification!.confidence).toBeLessThan(CLASSIFIER_CONFIDENCE_THRESHOLD)
  })

  it("falls back to fixed in non-interactive when below secondary threshold", () => {
    vi.spyOn(documentClassifier, "heuristicClassify").mockReturnValue({
      strategy: "narrative",
      confidence: 0.3,
      level: 1,
      reasoning: ["ambiguous signals"],
      requiresUserConfirmation: true,
    })

    const result = resolveIngestStrategy({
      content: "stub",
      config: { mode: "auto" },
      interactive: false,
    })
    expect(result.strategy).toBe("fixed")
    expect(result.source).toBe("classifier-conservative-fallback")
    expect(result.requiresUserPrompt).toBe(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
