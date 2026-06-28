/**
 * Tests for the Level-1 heuristic document classifier. Each fixture
 * is a minimal document representative of a real document class
 * (encyclopedia, narrative, technical, unstructured) and the
 * assertions pin down the classifier's accuracy on clear cases.
 */
import { describe, it, expect } from "vitest"
import {
  heuristicClassify,
  classifyStrategy,
  computeDocumentStats,
} from "./document-classifier"
import { CLASSIFIER_CONFIDENCE_THRESHOLD } from "@/types/ingest"

// ── Fixture builders ─────────────────────────────────────────────

/** Build an encyclopedia-like document: many short named sections. */
function buildEncyclopedia(sectionCount: number, entriesPerSection: number): string {
  const parts: string[] = [
    "---",
    "title: Compendio Enciclopedico",
    "type: concept",
    "---",
    "# Compendio",
  ]
  for (let s = 1; s <= sectionCount; s++) {
    parts.push(`## Sezione ${s}`)
    parts.push(`Breve introduzione alla sezione ${s}.`)
    for (let e = 1; e <= entriesPerSection; e++) {
      parts.push(`### Voce ${s}.${e}`)
      parts.push(`Descrizione concisa della voce ${s}.${e}.`)
    }
  }
  return parts.join("\n")
}

/** Build a narrative-like document: chapter headings + long prose + dialogue. */
function buildNarrative(chapterCount: number, paragraphsPerChapter: number): string {
  const parts: string[] = []
  for (let c = 1; c <= chapterCount; c++) {
    parts.push(`# Capitolo ${c}`)
    parts.push("")
    for (let p = 0; p < paragraphsPerChapter; p++) {
      // Long paragraph with dialogue markers
      parts.push(
        `Gaman si avvicinò alla porta e bussò tre volte. «Chi è?» chiese una voce dall'interno. «Sono Gaman,` +
          ` figlio di Thorin» rispose il nano. La porta si aprì lentamente rivelando un corridoio illuminato da` +
          ` torce. «Benvenuto a Kélamnkor» disse la guardia. Gaman entrò e percorse il lungo corridoio di pietra.` +
          ` Le pareti erano decorate con antiche incisioni che raccontavano la storia dei Nani delle Montagne.`,
      )
      parts.push("")
    }
  }
  return parts.join("\n")
}

/** Build a technical doc: code blocks, few headings, no frontmatter. */
function buildTechnicalDoc(): string {
  return [
    "# API Reference",
    "",
    "## Installation",
    "",
    "```bash",
    "npm install llm-wiki",
    "```",
    "",
    "## Usage",
    "",
    "```typescript",
    "import { autoIngest } from 'llm-wiki'",
    "await autoIngest(projectPath, sourcePath, config)",
    "```",
    "",
    "## Configuration",
    "",
    "The configuration object accepts the following fields:",
    "",
    "- `projectPath`: absolute path to the project",
    "- `sourcePath`: absolute path to the source file",
    "- `config`: LLM configuration object",
  ].join("\n")
}

/** Unstructured prose: no headings, no dialogue, no frontmatter. */
function buildUnstructuredProse(): string {
  return [
    "This is just a block of prose with no structure whatsoever.",
    "It goes on for a while without any headings or clear sections.",
    "The reader has to parse it linearly because there are no signposts.",
    "It might be an essay, a blog post, or a stream of consciousness.",
    "Either way, the heading-aware ingest can't do much with it.",
  ].join("\n\n")
}

// ── computeDocumentStats ─────────────────────────────────────────

describe("computeDocumentStats", () => {
  it("counts headings and density", () => {
    const stats = computeDocumentStats("# H1\n## H2\n## H3\nbody")
    expect(stats.headingCount).toBe(3)
    expect(stats.headingDensity).toBeGreaterThan(0)
  })

  it("ignores headings inside code fences", () => {
    const stats = computeDocumentStats([
      "# Real",
      "```",
      "# Not a heading",
      "## Also not",
      "```",
    ].join("\n"))
    expect(stats.headingCount).toBe(1)
  })

  it("detects frontmatter", () => {
    expect(computeDocumentStats("---\ntitle: X\n---\n# H").hasFrontmatter).toBe(true)
    expect(computeDocumentStats("# H\nbody").hasFrontmatter).toBe(false)
  })

  it("counts dialogue markers", () => {
    const stats = computeDocumentStats('«Ciao» disse lui. "Hello" she said.')
    expect(stats.dialogueCount).toBe(2)
  })

  it("detects chapter-like headings", () => {
    const stats = computeDocumentStats("# Capitolo 1\n# Capitolo 2\n# Other")
    expect(stats.chapterHeadingRatio).toBeCloseTo(2 / 3, 2)
  })
})

// ── heuristicClassify — encyclopedia ─────────────────────────────

describe("heuristicClassify — encyclopedia", () => {
  const compendio = buildEncyclopedia(9, 30) // 270 entries

  it("classifies as encyclopedia", () => {
    const result = heuristicClassify(compendio)
    expect(result.strategy).toBe("encyclopedia")
    expect(result.level).toBe(1)
  })

  it("has high confidence on a clear encyclopedia", () => {
    const result = heuristicClassify(compendio)
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD)
    expect(result.requiresUserConfirmation).toBe(false)
  })

  it("includes reasoning about the signals", () => {
    const result = heuristicClassify(compendio)
    expect(result.reasoning.length).toBeGreaterThan(0)
    expect(result.reasoning.some((r) => r.includes("heading density"))).toBe(true)
  })
})

// ── heuristicClassify — narrative ────────────────────────────────

describe("heuristicClassify — narrative", () => {
  const romanzo = buildNarrative(10, 8) // 10 chapters of long prose

  it("classifies as narrative", () => {
    const result = heuristicClassify(romanzo)
    expect(result.strategy).toBe("narrative")
    expect(result.level).toBe(1)
  })

  it("has high confidence on a clear narrative", () => {
    const result = heuristicClassify(romanzo)
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD)
    expect(result.requiresUserConfirmation).toBe(false)
  })

  it("reasoning mentions chapter headings or dialogue", () => {
    const result = heuristicClassify(romanzo)
    const joined = result.reasoning.join(" ")
    expect(
      joined.includes("chapter") || joined.includes("dialogue") || joined.includes("long sections"),
    ).toBe(true)
  })
})

// ── heuristicClassify — technical / unstructured ─────────────────

describe("heuristicClassify — technical and unstructured", () => {
  it("classifies technical doc as encyclopedia or fixed (not narrative)", () => {
    const result = heuristicClassify(buildTechnicalDoc())
    // A technical API doc is structurally similar to an encyclopedia
    // (short named sections, high density). At Level 1 this is an
    // acceptable classification — both use heading-aware chunking.
    // The key assertion: it must NOT be classified as narrative.
    expect(result.strategy).not.toBe("narrative")
  })

  it("classifies unstructured prose as fixed", () => {
    const result = heuristicClassify(buildUnstructuredProse())
    expect(result.strategy).toBe("fixed")
    expect(result.requiresUserConfirmation).toBe(true)
  })

  it("empty string → fixed, low confidence", () => {
    const result = heuristicClassify("")
    expect(result.strategy).toBe("fixed")
    expect(result.requiresUserConfirmation).toBe(true)
  })
})

// ── classifyStrategy convenience wrapper ─────────────────────────

describe("classifyStrategy", () => {
  it("returns just the strategy string", () => {
    expect(classifyStrategy(buildEncyclopedia(5, 10))).toBe("encyclopedia")
    expect(classifyStrategy(buildNarrative(5, 5))).toBe("narrative")
    expect(typeof classifyStrategy("prose")).toBe("string")
  })
})

// ── Confidence threshold semantics ───────────────────────────────

describe("requiresUserConfirmation", () => {
  it("is false when confidence >= threshold", () => {
    const result = heuristicClassify(buildEncyclopedia(9, 30))
    expect(result.confidence).toBeGreaterThanOrEqual(CLASSIFIER_CONFIDENCE_THRESHOLD)
    expect(result.requiresUserConfirmation).toBe(false)
  })

  it("is true when confidence < threshold", () => {
    const result = heuristicClassify(buildUnstructuredProse())
    expect(result.confidence).toBeLessThan(CLASSIFIER_CONFIDENCE_THRESHOLD)
    expect(result.requiresUserConfirmation).toBe(true)
  })
})
