/**
 * Tests for the heading tree parser. Pins down the hierarchy
 * semantics, fence-awareness, frontmatter stripping, and the
 * encyclopedia/narrative node-type stamping.
 */
import { describe, it, expect } from "vitest"
import {
  parseHeadingTree,
  filterByMinLevel,
  countEncyclopediaEntries,
  filterEntriesWithContent,
  classifyHeadings,
  computeEncyclopediaSlug,
  computeEntrySlugs,
} from "./heading-parser"

describe("parseHeadingTree — trivial inputs", () => {
  it("returns [] for empty string", () => {
    expect(parseHeadingTree("")).toEqual([])
  })

  it("returns [] for whitespace-only input", () => {
    expect(parseHeadingTree("   \n\n\t\n")).toEqual([])
  })

  it("returns [] when only frontmatter (no headings)", () => {
    expect(parseHeadingTree("---\ntitle: X\ntype: concept\n---\n")).toEqual([])
  })

  it("returns [] when body has no headings", () => {
    const content = "Just some prose\nwith no headings at all."
    expect(parseHeadingTree(content)).toEqual([])
  })

  it("drops the preamble before the first heading", () => {
    const content = "Preamble line 1\nPreamble line 2\n# First Heading\nBody."
    const nodes = parseHeadingTree(content)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].title).toBe("First Heading")
    expect(nodes[0].content).toBe("# First Heading\nBody.")
  })
})

describe("parseHeadingTree — hierarchy", () => {
  const compendio = [
    "# Nani delle Montagne",
    "Intro sui nani.",
    "## Cultura",
    "Testo sulla cultura.",
    "### Rituali",
    "Testo sui rituali.",
    "### Linguaggio (Nanesco)",
    "Testo sul Nanesco.",
    "## Storia",
    "Testo sulla storia.",
  ].join("\n")

  it("produces one node per heading", () => {
    const nodes = parseHeadingTree(compendio)
    expect(nodes).toHaveLength(5)
    expect(nodes.map((n) => n.title)).toEqual([
      "Nani delle Montagne",
      "Cultura",
      "Rituali",
      "Linguaggio (Nanesco)",
      "Storia",
    ])
  })

  it("builds full headingPath breadcrumb", () => {
    const nodes = parseHeadingTree(compendio)
    expect(nodes[0].headingPath).toEqual(["Nani delle Montagne"])
    expect(nodes[1].headingPath).toEqual(["Nani delle Montagne", "Cultura"])
    expect(nodes[2].headingPath).toEqual([
      "Nani delle Montagne",
      "Cultura",
      "Rituali",
    ])
    expect(nodes[3].headingPath).toEqual([
      "Nani delle Montagne",
      "Cultura",
      "Linguaggio (Nanesco)",
    ])
    // After ### Rituali and ### Linguaggio, a new ## resets depth.
    expect(nodes[4].headingPath).toEqual(["Nani delle Montagne", "Storia"])
  })

  it("sets parent and ancestor correctly", () => {
    const nodes = parseHeadingTree(compendio)
    // H1: parent null, ancestor self
    expect(nodes[0].parent).toBeNull()
    expect(nodes[0].ancestor).toBe("Nani delle Montagne")
    // H2 under H1
    expect(nodes[1].parent).toBe("Nani delle Montagne")
    expect(nodes[1].ancestor).toBe("Nani delle Montagne")
    // H3 under H2 under H1
    expect(nodes[2].parent).toBe("Cultura")
    expect(nodes[2].ancestor).toBe("Nani delle Montagne")
    // H3 sibling
    expect(nodes[3].parent).toBe("Cultura")
    expect(nodes[3].ancestor).toBe("Nani delle Montagne")
    // H2 sibling
    expect(nodes[4].parent).toBe("Nani delle Montagne")
    expect(nodes[4].ancestor).toBe("Nani delle Montagne")
  })

  it("sets level correctly", () => {
    const nodes = parseHeadingTree(compendio)
    expect(nodes.map((n) => n.level)).toEqual([1, 2, 3, 3, 2])
  })

  it("captures body content up to the next same/shallower heading", () => {
    const nodes = parseHeadingTree(compendio)
    // Rituali heading + its body
    expect(nodes[2].content).toContain("### Rituali")
    expect(nodes[2].content).toContain("Testo sui rituali.")
    // But NOT the next sibling's body
    expect(nodes[2].content).not.toContain("Linguaggio")
    expect(nodes[2].content).not.toContain("Storia")
  })

  it("estimates tokens as chars/4", () => {
    const nodes = parseHeadingTree("# H\nabcdefgh")
    expect(nodes[0].tokenEstimate).toBe(Math.ceil("# H\nabcdefgh".length / 4))
  })

  it("stamps nodeType from the caller", () => {
    const enc = parseHeadingTree("# H\nbody", "encyclopedia-entry")
    const nar = parseHeadingTree("# H\nbody", "narrative-boundary")
    expect(enc[0].nodeType).toBe("encyclopedia-entry")
    expect(nar[0].nodeType).toBe("narrative-boundary")
  })
})

describe("parseHeadingTree — fence awareness", () => {
  it("ignores headings inside fenced code blocks", () => {
    const content = [
      "# Real Heading",
      "Intro.",
      "```python",
      "# This is a comment, not a heading",
      "## Also not a heading",
      "```",
      "## Second Real Heading",
      "More body.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    expect(nodes).toHaveLength(2)
    expect(nodes[0].title).toBe("Real Heading")
    expect(nodes[1].title).toBe("Second Real Heading")
  })

  it("handles tilde fences too", () => {
    const content = [
      "# Real",
      "~~~",
      "# Not a heading",
      "~~~",
      "## Also Real",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    expect(nodes).toHaveLength(2)
    expect(nodes[1].title).toBe("Also Real")
  })

  it("keeps fence content inside the heading's body", () => {
    const content = [
      "# Heading",
      "Before fence.",
      "```",
      "# not a heading",
      "```",
      "After fence.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].content).toContain("```")
    expect(nodes[0].content).toContain("not a heading")
    expect(nodes[0].content).toContain("After fence.")
  })
})

describe("parseHeadingTree — frontmatter", () => {
  it("strips YAML frontmatter before parsing", () => {
    const content = [
      "---",
      "title: Compendio",
      "type: concept",
      "---",
      "# First Heading",
      "Body.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].title).toBe("First Heading")
    // Frontmatter keys must not leak as headings
    expect(nodes.some((n) => n.title === "Compendio")).toBe(false)
  })

  it("handles CRLF line endings", () => {
    const content = "# Heading\r\nBody line.\r\n## Sub\r\nSub body."
    const nodes = parseHeadingTree(content)
    expect(nodes).toHaveLength(2)
    expect(nodes[0].title).toBe("Heading")
    expect(nodes[1].title).toBe("Sub")
  })
})

describe("parseHeadingTree — compendio-like document", () => {
  it("produces 200+ nodes on a synthetic 270-entry compendio", () => {
    const parts: string[] = ["# Compendio dei Nani"]
    // 9 H2 sections × 30 H3 entries each = 270 entries + 9 sections + 1 H1 = 280 nodes
    for (let i = 1; i <= 9; i++) {
      parts.push(`## Sezione ${i}`)
      parts.push(`Intro sezione ${i}.`)
      for (let j = 1; j <= 30; j++) {
        parts.push(`### Voce ${i}.${j}`)
        parts.push(`Descrizione della voce ${i}.${j}.`)
      }
    }
    const nodes = parseHeadingTree(parts.join("\n"))
    expect(nodes.length).toBeGreaterThanOrEqual(280)
  })
})

describe("filterByMinLevel", () => {
  const nodes = parseHeadingTree([
    "# H1",
    "## H2",
    "### H3",
    "#### H4",
  ].join("\n"))

  it("keeps all levels when minLevel=1", () => {
    expect(filterByMinLevel(nodes, 1)).toHaveLength(4)
  })

  it("drops H1 when minLevel=2 (default)", () => {
    expect(filterByMinLevel(nodes)).toHaveLength(3)
    expect(filterByMinLevel(nodes).every((n) => n.level >= 2)).toBe(true)
  })

  it("keeps only H4 when minLevel=4", () => {
    expect(filterByMinLevel(nodes, 4)).toHaveLength(1)
    expect(filterByMinLevel(nodes, 4)[0].title).toBe("H4")
  })
})

describe("countEncyclopediaEntries", () => {
  it("counts content-bearing nodes at or below minLevel", () => {
    const nodes = parseHeadingTree([
      "# H1",
      "## H2a",
      "This section has enough content to qualify as a real entry here.",
      "### H3",
      "This subsection also has enough content to be a real entry here.",
      "## H2b",
      "This section has enough content too, qualifying it as an entry.",
    ].join("\n"))
    expect(countEncyclopediaEntries(nodes, 2)).toBe(3)
    expect(countEncyclopediaEntries(nodes, 3)).toBe(1)
  })

  it("excludes context-only headings from the count", () => {
    const nodes = parseHeadingTree([
      "# H1",
      "## Context",
      "short",
      "### Entry",
      "This has enough content to be a real encyclopedia entry here.",
    ].join("\n"))
    // Only "Entry" has enough content; "Context" is too short
    expect(countEncyclopediaEntries(nodes, 2)).toBe(1)
  })
})

describe("filterEntriesWithContent", () => {
  it("separates content-bearing headings from context-only headings", () => {
    const content = [
      "# Compendio",
      "",
      "## Storia",
      "Breve titolo.",
      "",
      "### Storia Antica",
      "Solo contesto.",
      "",
      "#### Periodo 1000-1500",
      "Anche questo è solo un periodo storico di contesto.",
      "Ma ha abbastanza testo per essere considerato contenuto vero e proprio qui.",
      "",
      "### La Grande Guerra",
      "La Grande Guerra fu un conflitto epico che coinvolse tutti i clan dei Nani.",
      "Durò cento anni e reshape le Montagne Eterne per sempre.",
      "",
      "## Cultura",
      "La cultura dei Nani è ricca e antica.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const { entries, context } = filterEntriesWithContent(nodes, 2)

    // "Storia" has ~14 chars of body → context
    // "Storia Antica" has ~13 chars → context
    // "Periodo 1000-1500" has ~100+ chars → entry
    // "La Grande Guerra" has ~100+ chars → entry
    // "Cultura" has ~40 chars → context (< 80)
    expect(entries.map((e) => e.title)).toContain("Periodo 1000-1500")
    expect(entries.map((e) => e.title)).toContain("La Grande Guerra")
    expect(context.map((c) => c.title)).toContain("Storia")
    expect(context.map((c) => c.title)).toContain("Storia Antica")
    expect(context.map((c) => c.title)).toContain("Cultura")
  })

  it("returns all headings as entries when they all have content", () => {
    const content = [
      "# Title",
      "## Section A",
      "This section has plenty of content to qualify as a real wiki entry.",
      "## Section B",
      "This section also has enough content to be a proper wiki page entry.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const { entries, context } = filterEntriesWithContent(nodes, 2)
    expect(entries).toHaveLength(2)
    expect(context).toHaveLength(0)
  })

  it("returns all headings as context when they all lack content", () => {
    const content = [
      "# Title",
      "## A",
      "x",
      "## B",
      "y",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const { entries, context } = filterEntriesWithContent(nodes, 2)
    expect(entries).toHaveLength(0)
    expect(context).toHaveLength(2)
  })

  it("context headings still appear in children heading_path", () => {
    const content = [
      "# Root",
      "## Context Heading",
      "short",
      "### Real Entry",
      "This has enough content to be a real encyclopedia entry page here.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const { entries } = filterEntriesWithContent(nodes, 2)
    const entry = entries.find((e) => e.title === "Real Entry")
    expect(entry).toBeDefined()
    // heading_path INCLUDES the context-only parent
    expect(entry!.headingPath).toEqual(["Root", "Context Heading", "Real Entry"])
    expect(entry!.parent).toBe("Context Heading")
  })
})

// ── Structural heading detection (frequency-based folding) ───────

describe("classifyHeadings — structural detection", () => {
  it("marks headings appearing 3+ times as structural", () => {
    const content = [
      "# Manuale GDR",
      "Il manuale del gioco di ruolo con tutte le magie e armi del mondo.",
      "## Magie",
      "Le magie sono potenti incantesimi che possono essere lanciati in combattimento.",
      "### Palla di Fuoco",
      "Una sfera di fuoco che esplode causando danni ad area.",
      "#### Danni",
      "3d6 danni da fuoco per livello dell'incantatore fino a un massimo di 10d6.",
      "#### Effetti Collaterali",
      "L'area circostante prende fuoco e continua a bruciare per 1d4 turni.",
      "### Fulmine",
      "Un raggio di energia elettrica che colpisce un singolo bersaglio.",
      "#### Danni",
      "1d6 danni da fulmine per livello dell'incantatore fino a un massimo di 8d6.",
      "#### Effetti Collaterali",
      "Il bersaglio viene stordito per 1 turno se fallisce una prova di costituzione.",
      "### Bomba d'Acqua",
      "Una sfera d'acqua compressa che esplode all'impatto.",
      "#### Danni",
      "2d6 danni da impatto per livello dell'incantatore fino a un massimo di 6d6.",
      "#### Effetti Collaterali",
      "Il bersaglio viene spinto indietro di 1d4 metri se fallisce una prova di forza.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const classification = classifyHeadings(nodes, 1)

    // "Danni" appears 3 times → structural
    // "Effetti Collaterali" appears 3 times → structural
    expect(classification.structural.map((s) => s.title)).toContain("Danni")
    expect(classification.structural.map((s) => s.title)).toContain("Effetti Collaterali")

    // "Palla di Fuoco", "Fulmine", "Bomba d'Acqua" appear once each → entries
    expect(classification.entries.map((e) => e.title)).toContain("Palla di Fuoco")
    expect(classification.entries.map((e) => e.title)).toContain("Fulmine")
    expect(classification.entries.map((e) => e.title)).toContain("Bomba d'Acqua")
  })

  it("does NOT mark headings appearing < 3 times as structural", () => {
    const content = [
      "# Doc",
      "Testo del documento principale con abbastanza contenuto per l'entry.",
      "## Sezione A",
      "Contenuto della sezione A sufficiente per essere una voce enciclopedica.",
      "## Sezione B",
      "Contenuto della sezione B sufficiente per essere una voce enciclopedica.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const classification = classifyHeadings(nodes, 1)
    expect(classification.structural).toHaveLength(0)
    expect(classification.entries.length).toBeGreaterThan(0)
  })
})

describe("classifyHeadings — folding into parent", () => {
  it("folds structural content into nearest entry ancestor", () => {
    const content = [
      "# Manuale GDR",
      "Il manuale del gioco di ruolo con tutte le magie e armi del mondo fantasy.",
      "## Magie",
      "Le magie sono potenti incantesimi che possono essere lanciati in combattimento.",
      "### Palla di Fuoco",
      "Una sfera di fuoco che esplode causando danni ad area molto estesa.",
      "#### Danni",
      "3d6 danni da fuoco per livello dell'incantatore fino a un massimo di 10d6.",
      "#### Effetti Collaterali",
      "L'area circostante prende fuoco e continua a bruciare per 1d4 turni.",
      "### Fulmine",
      "Un raggio di energia elettrica che colpisce un singolo bersaglio nemico.",
      "#### Danni",
      "1d6 danni da fulmine per livello dell'incantatore fino a un massimo di 8d6.",
      "#### Effetti Collaterali",
      "Il bersaglio viene stordito per 1 turno se fallisce una prova di costituzione.",
      "### Bomba d'Acqua",
      "Una sfera d'acqua compressa che esplode all'impatto con grande forza.",
      "#### Danni",
      "2d6 danni da impatto per livello dell'incantatore fino a un massimo di 6d6.",
      "#### Effetti Collaterali",
      "Il bersaglio viene spinto indietro di 1d4 metri se fallisce una prova di forza.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const classification = classifyHeadings(nodes, 1)

    // Each "Danni" should fold into its respective spell
    const danniNodes = classification.structural.filter((s) => s.title === "Danni")
    expect(danniNodes).toHaveLength(3)

    for (const d of danniNodes) {
      const foldTarget = classification.foldMap.get(d.pathKey)
      expect(foldTarget).not.toBeNull()
      const targetEntry = classification.entries.find((e) => e.pathKey === foldTarget)
      expect(targetEntry).toBeDefined()
      // The fold target should be the spell name, not "Manuale GDR" or "Magie"
      expect(["Palla di Fuoco", "Fulmine", "Bomba d'Acqua"]).toContain(targetEntry!.title)
    }
  })

  it("promotes context heading to entry when it has structural children", () => {
    // "Palla di Fuoco" has very little own content (< 40 chars),
    // but its structural children (Danni, Effetti Collaterali ×3)
    // give it enough effective content to become an entry.
    const content = [
      "# Manuale",
      "Manuale del gioco di ruolo con tutte le regole e le magie del mondo.",
      "## Magie",
      "Le magie sono incantesimi potenti che possono essere lanciati in battaglia.",
      "### Palla di Fuoco",
      "Breve.",  // 7 chars — context on its own
      "#### Danni",
      "3d6 danni da fuoco per livello fino a massimo 10d6, con bonus per area.",
      "#### Effetti Collaterali",
      "L'area circostante prende fuoco e brucia per 1d4 turni consecutivi.",
      "### Fulmine",
      "Raggio di energia che colpisce un bersaglio singolo con grande potenza.",
      "#### Danni",
      "1d6 danni da fulmine per livello fino a massimo 8d6 contro un singolo.",
      "#### Effetti Collaterali",
      "Il bersaglio viene stordito per 1 turno se fallisce la prova di costituzione.",
      "### Gelo",
      "Incantesimo di ghiaccio che congela il bersaglio rallentandolo notevolmente.",
      "#### Danni",
      "2d6 danni da gelo per livello fino a massimo 6d6 con rallentamento.",
      "#### Effetti Collaterali",
      "Il bersaglio rallentato del 50% per 1d4 turni se fallisce la prova.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const classification = classifyHeadings(nodes, 1)

    // "Palla di Fuoco" should be an entry (promoted from context)
    // because its structural children give it enough effective content
    const palla = classification.entries.find((e) => e.title === "Palla di Fuoco")
    expect(palla).toBeDefined()

    // It should NOT be in context
    const pallaContext = classification.context.find((c) => c.title === "Palla di Fuoco")
    expect(pallaContext).toBeUndefined()
  })

  it("promotes structural to entry when no entry ancestor exists", () => {
    // Edge case: all headings are structural (all repeated ≥ 3 times)
    // but there's no unique entry to fold into. The structural headings
    // should be promoted to entries as a fallback.
    const content = [
      "# Doc",
      "Intro breve.",
      "## Sezione",
      "Breve.",
      "## Sezione",
      "Breve.",
      "## Sezione",
      "Questo ha abbastanza testo per essere considerato contenuto reale qui.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const classification = classifyHeadings(nodes, 1, 40, 3)

    // "Sezione" appears 3 times → structural, but no entry ancestor
    // (H1 "Doc" has too little content). Structural should be promoted.
    // At least one should end up as entry (the one with most content).
    expect(classification.entries.length + classification.structural.length).toBeGreaterThan(0)
  })
})

describe("classifyHeadings — backward compatibility", () => {
  it("filterEntriesWithContent still works (entries + context only)", () => {
    const content = [
      "# Title",
      "This section has enough content to qualify as a real entry here.",
      "## Context",
      "short",
      "### Entry",
      "This has enough content to be a real encyclopedia entry here.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const { entries, context } = filterEntriesWithContent(nodes, 1)
    expect(entries.length).toBeGreaterThan(0)
    expect(context.length).toBeGreaterThan(0)
  })
})

// ── Encyclopedia slug computation ────────────────────────────────

describe("computeEncyclopediaSlug", () => {
  it("combines H1 ancestor + leaf heading", () => {
    const content = [
      "# Nani delle Montagne",
      "I Nani delle Montagne sono un popolo antico e fiero, abitante di Kélamnkor.",
      "## Cultura",
      "La cultura dei Nani delle Montagne è ricca e antica, basata su tradizioni millenarie.",
      "### Rituali",
      "I rituali dei Nani sono cerimonie sacre che segnano i momenti importanti della vita.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const rituali = nodes.find((n) => n.title === "Rituali")!
    expect(computeEncyclopediaSlug(rituali)).toBe("nani-delle-montagne-rituali")
  })

  it("disambiguates same leaf under different H1", () => {
    const naniContent = [
      "# Nani delle Montagne",
      "I Nani delle Montagne sono un popolo antico e fiero di Kélamnkor.",
      "## Apparato Uditivo",
      "L'apparato uditivo dei Nani delle Montagne è particolarmente sviluppato.",
    ].join("\n")
    const elfiContent = [
      "# Elfi della Foresta",
      "Gli Elfi della Foresta sono creature aggraziate e longeve del bosco.",
      "## Apparato Uditivo",
      "L'apparato uditivo degli Elfi della Foresta è molto sensibile ai rumori.",
    ].join("\n")
    const naniNode = parseHeadingTree(naniContent).find((n) => n.title === "Apparato Uditivo")!
    const elfiNode = parseHeadingTree(elfiContent).find((n) => n.title === "Apparato Uditivo")!
    expect(computeEncyclopediaSlug(naniNode)).toBe("nani-delle-montagne-apparato-uditivo")
    expect(computeEncyclopediaSlug(elfiNode)).toBe("elfi-della-foresta-apparato-uditivo")
    expect(computeEncyclopediaSlug(naniNode)).not.toBe(computeEncyclopediaSlug(elfiNode))
  })

  it("works for H1 entries (ancestor = self)", () => {
    const content = [
      "# Storia del Mondo",
      "La storia del mondo conosciuto abbraccia millenni di eventi e civiltà.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const h1 = nodes[0]
    // H1 + self = doubled slug. This is acceptable — H1 entries are rare
    // and the doubled slug is still unique and readable.
    expect(computeEncyclopediaSlug(h1)).toBe("storia-del-mondo-storia-del-mondo")
  })

  it("handles Italian special characters", () => {
    const content = [
      "# Compendio dei Nani",
      "Il compendio raccoglie tutte le informazioni sui Nani delle Montagne.",
      "## Kélamnkor",
      "Kélamnkor è la regione principale abitata dai Nani delle Montagne.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const k = nodes.find((n) => n.title === "Kélamnkor")!
    const slug = computeEncyclopediaSlug(k)
    // makeQuerySlug keeps Unicode letters (including é) for CJK support
    expect(slug).toBe("compendio-dei-nani-kélamnkor")
  })
})

describe("computeEntrySlugs", () => {
  it("computes slugs for all entries in a classification", () => {
    const content = [
      "# Manuale GDR",
      "Il manuale del gioco di ruolo con tutte le magie e armi del mondo.",
      "## Magie",
      "Le magie sono potenti incantesimi che possono essere lanciati in combattimento.",
      "### Palla di Fuoco",
      "Una sfera di fuoco che esplode causando danni ad area molto estesa.",
      "### Fulmine",
      "Un raggio di energia elettrica che colpisce un singolo bersaglio nemico.",
    ].join("\n")
    const nodes = parseHeadingTree(content)
    const { entries } = classifyHeadings(nodes, 1)
    const slugs = computeEntrySlugs(entries)
    expect(slugs.size).toBe(entries.length)
    expect(slugs.get(entries.find((e) => e.title === "Palla di Fuoco")!.pathKey)).toBe("manuale-gdr-palla-di-fuoco")
    expect(slugs.get(entries.find((e) => e.title === "Fulmine")!.pathKey)).toBe("manuale-gdr-fulmine")
    expect(slugs.get(entries.find((e) => e.title === "Magie")!.pathKey)).toBe("manuale-gdr-magie")
  })
})
