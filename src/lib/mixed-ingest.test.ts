import { describe, it, expect } from "vitest"
import { splitDocumentByH1, buildMixedIngestPlan } from "@/lib/mixed-ingest"

const ROMANZO_APPENDICE = `# Capitolo 1

Prose with «dialogue» here.

# Glossario

| Nome | tipo |
| --- | --- |
| ITA | type |
| Gaman | personaggio |
| Nodfri | personaggio |
| Eldur | personaggio |
| Eira | personaggio |
| Thorin | personaggio |
| Kélamnkor | luogo |
| Fiòrderik | luogo |
| Glendark | luogo |
| Verdiconfini | luogo |
| Soeliok | oggetto |
`

describe("splitDocumentByH1", () => {
  it("splits into chapters and appendix", () => {
    const sections = splitDocumentByH1(ROMANZO_APPENDICE)
    expect(sections.length).toBeGreaterThanOrEqual(2)
    expect(sections.some((s) => s.headingTitle.includes("Glossario"))).toBe(true)
  })
})

describe("buildMixedIngestPlan", () => {
  it("classifies appendix table as tabular", () => {
    const plan = buildMixedIngestPlan(ROMANZO_APPENDICE)
    const glossario = plan.sections.find((s) => s.headingTitle.includes("Glossario"))
    expect(glossario?.strategy).toBe("tabular")
  })

  it("classifies narrative chapter as narrative", () => {
    const plan = buildMixedIngestPlan(ROMANZO_APPENDICE)
    const cap = plan.sections.find((s) => s.headingTitle.includes("Capitolo"))
    expect(cap?.strategy).toBe("narrative")
  })
})
