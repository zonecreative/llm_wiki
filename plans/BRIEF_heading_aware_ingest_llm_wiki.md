# BRIEF — Heading-Aware Ingest Strategy per llm_wiki
**Progetto:** ZoneCreative fork di `nashsu/llm_wiki`  
**Branch target:** `feat/heading-aware-ingest`  
**Data:** Giugno 2026  
**Destinatario:** Agente AI incaricato di produrre il piano di implementazione dettagliato

---

## 1. Contesto e obiettivo

### Il progetto
`llm_wiki` è un'app desktop Tauri (Rust backend + React 19 + TypeScript frontend) che trasforma documenti in una wiki strutturata con knowledge graph. Il corpus di ZoneCreative include:

- **Libri narrativi** (3 romanzi fantasy della saga Soeliok)
- **Compendio enciclopedico** (270 pagine sui Nani delle Montagne — Nanesco, Cultura, Storia, Kélamnkor, personaggi, luoghi, oggetti...)
- **Documenti tecnici e di progetto** ZoneCreative
- **Documenti ibridi** (es. romanzi con appendici enciclopediche)

### Il problema attuale
L'ingest usa chunking fisso (token window). Su documenti enciclopedici strutturati questo causa:

1. **Entità perse** — una voce enciclopedica viene spezzata a metà dal chunk boundary, il LLM non riconosce l'entità completa
2. **Grafo sparso** — un compendio da 270 voci produce pochi nodi invece di 270+
3. **Contesto heading perso** — il LLM non sa che `## Rituali` è una voce autonoma sotto `# Cultura dei Nani`
4. **Relazioni gerarchiche assenti** — la struttura padre-figlio degli heading non si riflette nel grafo

### L'obiettivo
Implementare una pipeline di ingest **semanticamente consapevole della struttura del documento**, che applichi strategie diverse in base alla natura del contenuto — senza richiedere input manuale obbligatorio dall'utente.

---

## 2. Stack tecnico (riferimento per l'agente)

| Layer | Tecnologia |
|---|---|
| Desktop | Tauri v2 |
| Backend | Rust 1.70+ |
| Frontend | React 19 + TypeScript + Vite |
| UI | shadcn/ui + Tailwind CSS v4 |
| Grafo | sigma.js + graphology + ForceAtlas2 |
| Vector DB | LanceDB (Rust, embedded, opzionale) |
| PDF | pdf-extract (Rust) |
| Office | docx-rs + calamine |
| State | Zustand |
| LLM | Streaming fetch (OpenAI, Anthropic, Google, Ollama, Custom) |

**Struttura repo:**
```
llm_wiki/
├── src/                    # Frontend TypeScript/React
│   ├── commands/           # Tauri invoke calls
│   ├── components/         # UI components
│   ├── lib/                # Logica frontend
│   ├── stores/             # Zustand stores
│   └── types/              # TypeScript types
├── src-tauri/              # Backend Rust
│   └── src/
│       ├── commands/       # Tauri commands (fs.rs, llm.rs, ...)
│       ├── clip_server.rs  # Server clip watcher porta 19827
│       └── main.rs / lib.rs
├── mcp-server/             # MCP server (compilare con npm run build prima di tauri dev)
└── extension/              # Chrome extension
```

**Issue correlata upstream:** #177 "Adaptive Chunking + Thinking Budget Controller" — propone `headingPath: string[]` nell'interfaccia `DocumentChunk`. La nostra feature è complementare e più ambiziosa: non solo usa gli heading come contesto, ma li tratta come entità garantite (modalità enciclopedia) o come boundary naturali di chunk (modalità narrativa).

---

## 3. Le tre strategie di ingest

### Strategia A — Fixed Chunks (esistente, invariata)
Chunking fisso a finestra di token. Default attuale. Va mantenuta invariata come fallback.

### Strategia B — Encyclopedia Mode
**Trigger:** documento enciclopedico/wiki con heading che delimitano voci autonome.

**Comportamento:**
- Parse deterministico dell'AST Markdown via `pulldown-cmark`
- Ogni heading `##`/`###` diventa un **nodo garantito** nel grafo
- Il chunk = heading + tutto il contenuto fino al prossimo heading dello stesso livello
- Il prompt LLM riceve il `heading_path` completo come contesto esplicito
- Il frontmatter generato include gerarchia: `parent`, `ancestor`, `heading_level`

**Esempio:**
```markdown
# Nani delle Montagne
## Cultura
### Rituali
Testo sui rituali...
### Linguaggio (Nanesco)
Testo sul Nanesco...
```
→ Genera nodi: `Nani delle Montagne`, `Cultura`, `Rituali`, `Linguaggio (Nanesco)`
→ Con relazioni gerarchiche: `Rituali → figlio_di → Cultura → figlio_di → Nani delle Montagne`

### Strategia C — Narrative Mode
**Trigger:** documento narrativo (romanzo, racconto) con heading che sono titoli di capitolo.

**Comportamento:**
- Gli heading vengono usati come **boundary naturali di chunk**, NON come entità
- Il chunk = contenuto del capitolo (testo narrativo coerente)
- Il prompt LLM riceve il titolo capitolo come **contesto temporale**, non come entità da creare
- Il LLM estrae entità dal contenuto (personaggi, luoghi, eventi, oggetti) e le collega al grafo esistente
- NON viene creato un nodo `Capitolo 3`

**Esempio prompt Narrative Mode:**
```
## Document context
Source: Soeliok - Libro I
Chapter boundary: "Capitolo 3 - La Discesa"
[CONTEXT ONLY — do not create a wiki page for this chapter]

## Content
[testo del capitolo]

## Instructions
Extract entities (characters, places, events, objects) from this passage.
Do NOT create a wiki page for the chapter itself.
Link extracted entities to existing wiki pages where possible.
Note first appearances, relationships, and events revealed in this passage.
```

---

## 4. Pipeline di classificazione automatica

La classificazione è **automatica e a cascata**. L'input manuale utente è l'**ultima risorsa**, non il default.

### Livello 1 — Euristica deterministica (gratis, < 5ms)

Analizza il documento con regole semplici senza LLM call:

```typescript
interface ClassificationResult {
  strategy: 'encyclopedia' | 'narrative' | 'fixed' | 'mixed' | 'unknown';
  confidence: number;        // 0.0 - 1.0
  reasoning: string[];       // log human-readable delle regole applicate
  sectionMap?: SectionType[]; // per documenti misti
}

function heuristicClassify(content: string): ClassificationResult {
  // Segnali da enciclopedia:
  // - heading density alta (>2 heading ogni 100 righe)
  // - heading corti (<40 caratteri) in proporzione >70%
  // - YAML frontmatter presente
  // - avg content tra heading breve (<800 token)
  
  // Segnali da narrativa:
  // - pattern "Capitolo|Chapter|Parte|Part \d" negli heading
  // - avg content tra heading lungo (>2000 token)
  // - heading rari (<0.5 ogni 100 righe)
  // - presenza di dialoghi (pattern "«..»" o "\"...\"" frequente)
}
```

**Soglia confidenza:** se `confidence >= 0.80` → applica strategia direttamente, skip Livello 2.

### Livello 2 — LLM Classifier (una call, ~500 token input)

Se Livello 1 restituisce `confidence < 0.80` o `unknown`:

```
Classify this document excerpt with a single word:
ENCYCLOPEDIA — structured reference with many short named sections (wiki, compendium, glossary, manual)
NARRATIVE — story, novel, or sequential prose with chapter divisions
TECHNICAL — code documentation, API reference
MIXED — contains both encyclopedic and narrative sections

Respond with: {"type": "ENCYCLOPEDIA|NARRATIVE|TECHNICAL|MIXED", "confidence": 0.0-1.0, "reason": "one sentence"}

Document excerpt (first 500 tokens):
[estratto]
```

**Soglia confidenza:** se `confidence >= 0.80` → applica strategia. Se `MIXED` → passa a Livello 3.

### Livello 3 — Document-level Split (per documenti misti)

Se il documento è `MIXED` (es. romanzo con appendice enciclopedica):

1. Identifica i boundary di sezione a livello H1
2. Classifica ogni sezione H1 separatamente (via euristica o LLM)
3. Applica strategia diversa per ogni sezione
4. Il grafo risultante è unificato — le entità narrative si collegano alle entità enciclopediche

**Esempio:**
```markdown
# Prefazione (→ Narrative Mode)
# Il Mondo di Soeliok (→ Encyclopedia Mode)  
## Kélamnkor
## Nani delle Montagne
# Appendice — Glossario (→ Encyclopedia Mode)
```

### Livello 4 — Conferma utente (ultima risorsa)

Solo se Livelli 1-3 non producono confidenza sufficiente:

- **NON** è un input cieco — il sistema mostra il proprio reasoning
- L'utente **conferma o corregge** una proposta già ragionata
- UI: dialog con suggerimento pre-compilato e spiegazione

```
llm_wiki ha analizzato "libro-soeliok-I.md":

Rilevato: prevalentemente NARRATIVO (72% confidenza)
Motivazione: heading pattern capitoli, contenuto medio 3.200 token/sezione

⚠️ Confidenza insufficiente per classificazione automatica.

Confermi la strategia suggerita?
  ● Narrative Mode (suggerito)
  ○ Encyclopedia Mode  
  ○ Fixed Chunks
  ○ Mixed (analisi per sezione)

[Conferma]  [Modifica]
```

---

## 5. Strutture dati

### HeadingNode (Rust)
```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HeadingNode {
    pub heading_path: Vec<String>,  // ["Nani delle Montagne", "Cultura", "Rituali"]
    pub level: u8,                  // 1..6
    pub title: String,              // testo dell'heading
    pub content: String,            // testo fino al prossimo stesso livello
    pub token_estimate: usize,      // content.len() / 4 (stima)
    pub node_type: HeadingNodeType, // Encyclopedia | NarrativeBoundary
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum HeadingNodeType {
    EncyclopediaEntry,   // → diventa nodo nel grafo
    NarrativeBoundary,   // → usato come chunk boundary, non come nodo
}
```

### ClassificationResult (TypeScript)
```typescript
interface ClassificationResult {
  strategy: 'encyclopedia' | 'narrative' | 'fixed' | 'mixed';
  confidence: number;
  level: 1 | 2 | 3 | 4;        // quale livello ha prodotto la classificazione
  reasoning: string[];
  requiresUserConfirmation: boolean;
  sectionMap?: {                 // per mixed
    headingTitle: string;
    headingLevel: number;
    strategy: 'encyclopedia' | 'narrative';
  }[];
}
```

### Frontmatter enciclopedico (output wiki)
```yaml
---
title: Rituali
type: concept
parent: "[[Cultura]]"
ancestor: "[[Nani delle Montagne]]"
heading_level: 3
heading_path: ["Nani delle Montagne", "Cultura", "Rituali"]
ingest_strategy: encyclopedia
sources: [compendio-nani.md]
---
```

---

## 6. Modifiche ai file esistenti

L'agente deve identificare e mappare con precisione i file da modificare. I punti di aggancio noti sono:

### Backend Rust (`src-tauri/src/`)
- **Nuovo file:** `heading_parser.rs` — parser AST con `pulldown-cmark`
- **Nuovo file:** `document_classifier.rs` — logica classificazione Livelli 1-3
- **Modifica:** `commands/fs.rs` — punto principale di ingest, aggiungere routing per strategia
- **Modifica:** `lib.rs` o `main.rs` — registrare nuovi comandi Tauri e nuovi moduli

### Frontend TypeScript (`src/`)
- **Nuovo file:** `lib/headingIngest.ts` — invoke Tauri + buildIngestPrompt per Encyclopedia/Narrative
- **Nuovo file:** `lib/documentClassifier.ts` — wrapper TypeScript per classificazione + UI state
- **Modifica:** componente impostazioni source (identificare il file corretto leggendo `src/components/`)
- **Modifica:** prompt templates LLM (identificare dove sono definiti i prompt di ingest)

### Dipendenze
- `src-tauri/Cargo.toml` → aggiungere `pulldown-cmark = "0.11"`

---

## 7. Criteri di test e benchmark

### Test primario — Compendio Nani delle Montagne
- **File:** compendio enciclopedico Soeliok, ~270 pagine Markdown
- **Atteso con Fixed Chunks:** grafo sparso, <50 nodi rilevanti
- **Atteso con Encyclopedia Mode:** 200+ nodi, uno per heading `##`/`###`
- **Metrica:** conteggio nodi nel grafo dopo ingest, verifica presenza heading noti

### Test secondario — Libro I Soeliok
- **File:** romanzo narrativo
- **Atteso con Narrative Mode:** nodi per personaggi/luoghi/eventi estratti dal testo, NESSUN nodo `Capitolo N`
- **Metrica:** assenza di nodi con titolo matching pattern capitolo, presenza entità narrative

### Test terziario — Documento ibrido
- **File:** documento con sezioni miste (se disponibile)
- **Atteso:** classificazione `MIXED`, sezioni diverse con strategie diverse, grafo unificato

### Test classificatore
- Suite di 10+ documenti di tipo noto → verifica accuracy classificazione automatica
- Logging del livello usato (1/2/3/4) per ogni documento

---

## 8. Fasi di implementazione (suggerimento ordine)

**Fase 1 — Parser e classificatore (Backend Rust)**
1. `heading_parser.rs` con `pulldown-cmark`
2. Test unitario del parser sul compendio Nani
3. `document_classifier.rs` — solo Livello 1 (euristica)
4. Esporre entrambi come comandi Tauri

**Fase 2 — Pipeline ingest Encyclopedia Mode**
1. `headingIngest.ts` con prompt Encyclopedia
2. Routing in `commands/fs.rs` per strategia encyclopedia
3. Frontmatter esteso con gerarchia
4. Test su compendio → verificare 200+ nodi

**Fase 3 — Pipeline ingest Narrative Mode**
1. Prompt Narrative Mode (heading come boundary, non entità)
2. Routing per strategia narrative
3. Test su romanzo → verificare assenza nodi-capitolo

**Fase 4 — Classificatore Livello 2 (LLM)**
1. Call LLM classifier per documenti a bassa confidenza euristica
2. Integrazione con pipeline esistente

**Fase 5 — Document-level Split (Mixed)**
1. Segmentazione H1-level
2. Classificazione per sezione
3. Ingest multi-strategia su stesso documento

**Fase 6 — UI e Livello 4 (conferma utente)**
1. Toggle visibile nelle impostazioni source
2. Dialog conferma per bassa confidenza
3. Logging classificazione nel `log.md` della wiki

---

## 9. Istruzioni per l'agente

### Cosa produrre
L'agente deve produrre un **piano di implementazione dettagliato** che includa:

1. **Mappa completa dei file da modificare** — leggere il codice sorgente del repo e identificare i punti di aggancio esatti (nomi funzioni, linee, pattern)
2. **Codice completo** per ogni nuovo file (heading_parser.rs, document_classifier.rs, headingIngest.ts, documentClassifier.ts)
3. **Diff minimali** per ogni file esistente da modificare
4. **Suite di test** Rust e TypeScript
5. **Ordine di commit** suggerito per PR pulita

### Vincoli
- **Nessuna breaking change** alla pipeline esistente — Fixed Chunks deve continuare a funzionare identicamente
- **Backward compatible** — wiki esistenti non devono essere reingestate
- **La scelta utente (Livello 4) è sempre disponibile** come override manuale, ma non è il default
- **Il sistema non si fida dell'input utente senza reasoning proprio** — mostra sempre il proprio suggerimento prima di accettare input

### Riferimenti da leggere prima di implementare
- `src-tauri/src/commands/fs.rs` — pipeline ingest principale
- `src/lib/` — utilities frontend esistenti
- `src/stores/` — state management, capire dove vive lo stato dell'ingest
- Issue upstream #177 per evitare conflitti con `headingPath[]` già proposto
- `src-tauri/Cargo.toml` — dipendenze Rust esistenti

### Note su pulldown-cmark
`pulldown-cmark` è il parser Markdown standard nell'ecosistema Rust. Probabilmente è già una dipendenza transitiva di qualche crate esistente nel progetto — verificare prima di aggiungerlo esplicitamente. Il parsing produce un iteratore di `Event` su cui si lavora in modo streaming, senza costruire un DOM completo.

---

## 10. Contesto dominio (per prompt LLM quality)

Il corpus principale è **Soeliok** — un universo fantasy italiano con:
- Lingua costruita: **Nanesco** (lingua dei Nani delle Montagne)
- Regione principale: **Kélamnkor**
- Popolo: **Nani delle Montagne** con cultura, rituali, storia propri
- Personaggi: tra cui **Gaman**
- Formato: romanzi + compendio enciclopedico + materiali di worldbuilding

I prompt LLM generati dalla pipeline devono funzionare bene su testi in **italiano** con termini fantasy inventati. Qwen3 e DeepSeek V4 Flash sono i modelli target (via OpenRouter) — entrambi con ottimo supporto multilingue.

---

*Brief prodotto da ZoneCreative — Giugno 2026*  
*Fork: `github.com/zonecreative/llm_wiki` branch `feat/heading-aware-ingest`*
