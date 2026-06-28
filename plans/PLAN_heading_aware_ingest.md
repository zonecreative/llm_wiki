# PLAN — Heading-Aware Ingest per llm_wiki

**Progetto:** ZoneCreative fork di `nashsu/llm_wiki`
**Branch target:** `feat/heading-aware-ingest`
**Data:** Giugno 2026
**Derivato da:** `plans/BRIEF_heading_aware_ingest_llm_wiki.md` (rettificato dopo analisi del codebase)

---

## Overview

Implementare una pipeline di ingest semanticamente consapevole della struttura del documento (Encyclopedia Mode, Narrative Mode) con classificazione automatica a cascata, mantenendo la Fixed Chunks esistente come fallback.

**Rettifica architetturale critica rispetto al brief:** l'intera pipeline di ingest vive nel frontend TypeScript (`src/lib/ingest.ts`), non nel backend Rust. Il brief collocava erroneamente ingest e chunking in `src-tauri/src/` (file inesistenti `ingestion.rs`, `commands/llm.rs`). Il backend resta responsabile solo di estrazione testo (`fs.rs`), FS ops e vector store — nessuna modifica Rust, niente `pulldown-cmark`. Tutti i nuovi moduli sono TypeScript in `src/lib/`.

---

## Architecture context

### Layer coinvolti
- **Frontend TS** (`src/lib/`, `src/stores/`, `src/components/settings/`, `src/types/`): pipeline ingest, prompt, chunking, classificazione, store, UI
- **Backend Rust** (`src-tauri/src/`): **invariato** — estrazione testo (`fs.rs`), FS ops, vector store, file sync
- **Wiki output** (`<project>/wiki/`): file markdown con frontmatter esteso (campi opzionali `parent`/`ancestor`/`heading_level`/`heading_path`/`ingest_strategy`)

### Pipeline corrente (`src/lib/ingest.ts:473` `autoIngest`)
```
readFile(sp) → sourceContent
  ↓
[cache check: checkIngestCache] → HIT: return cached files
  ↓ MISS
[MinerU PDF preprocessing opzionale]
  ↓
[immagini: extract + caption opzionale]
  ↓
computeIngestSourceBudget → se source > budget:
  splitSourceIntoSemanticChunks → analyzeLongSourceInChunks (multi-LLM, checkpoint)
  ↓
Step 1: streamChat(buildAnalysisPrompt) → analysis
  ↓
Step 2: streamChat(buildGenerationPrompt) → generation (FILE/REVIEW blocks)
  ↓
[review suggestion stage opzionale]
  ↓
Step 3: writeFileBlocks → parseFileBlocks → write wiki/*.md (con merge LLM)
  ↓
Step 4: parseReviewBlocks
  ↓
Step 5: saveIngestCache
  ↓
Step 6: embedPage (se embedding abilitato)
```

### Pattern riusati (con file path)
- `src/lib/text-chunker.ts:163` `splitIntoSections` — heading stack + fence-aware, riusato per heading parsing
- `src/lib/text-chunker.ts:131` `stripFrontmatter` — riusa
- `src/lib/ingest.ts:2156` `semanticBlocks` — heading stack + paragraph split, già usato da `splitSourceIntoSemanticChunks`
- `src/lib/templates.ts:189` `readingTemplate` — già definisce `character`/`theme`/`plot-thread`/`chapter` per narrativa
- `src/lib/wiki-page-types.ts:1` `GENERATION_WIKI_TYPES` — estendere, non rimpiazzare
- `src/lib/frontmatter.ts:37` `parseFrontmatter` — gestisce già YAML esteso e `repairWikilinkLists`
- `src/lib/detect-language.ts` — pattern per euristica pura, deterministica, testabile

### Vincoli rispettati
- **Nessuna breaking change** alla pipeline esistente — Fixed Chunks (`mode: "fixed"`) continua a funzionare identicamente
- **Backward compatible** — wiki esistenti non devono essere reingestate; i nuovi campi frontmatter sono opzionali
- **Cache compatibility** — cache key e `LongSourceCheckpoint` estesi con `ingestStrategy`; entry pre-feature vengono trattate come incompatibili (re-ingest automatico sicuro)
- **Project lock** — la classificazione Livello 1 (euriistica < 5ms) gira dentro `withProjectLock` senza impatto; Livello 2 (LLM) eventualmente fuori lock
- **Schema routing** — `validateWikiPageRouting` (`src/lib/wiki-schema.ts`) non viene bypassato; i nuovi path `wiki/concepts/<slug>.md` passano la validazione esistente

---

## Design decisions

### Decisione 1 — Tutto frontend TypeScript, niente Rust
La pipeline di ingest, i prompt, il chunking e la classificazione vivono in TS. Aggiungere `pulldown-cmark` in Rust duplicherebbe parsing già fatto con regex in `text-chunker.ts`. Il backend resta responsabile solo di estrazione testo e FS.

### Decisione 2 — Estendere `text-chunker.ts`, non creare parser concorrente
Il brief proponeva `heading_parser.rs` nuovo. Invece si aggiunge `parseHeadingTree(content): HeadingNode[]` in `src/lib/heading-parser.ts` che riusa `splitIntoSections` di `text-chunker.ts`. `HeadingNode` è la controparte TS dello struct Rust del brief.

### Decisione 3 — `headingPath` promosso da `string` a `string[]`
`SourceChunk.headingPath` (`ingest.ts:173`) e `Chunk.headingPath` (`text-chunker.ts:75`) sono già `string` formattata `"## H2 > ### H3"`. Si aggiunge un campo `headingPathArray?: string[]` (es. `["Nani delle Montagne", "Cultura", "Rituali"]`) mantenendo backward compat con la stringa (deprecata). Allinea con issue upstream #177.

### Decisione 4 — Classificatore a 3 livelli (non 4), posticipando MIXED
- **Livello 1** (euristica deterministica in TS): implementare subito
- **Livello 4** (override manuale con reasoning mostrato): implementare subito
- **Livello 2** (LLM classifier): **posticipato** a Fase 4 — costa una LLM call per documento a bassa confidenza, ROI basso finché l'euriistica è ben tarata
- **Livello 3** (MIXED split per H1): **posticipato** a Fase 5 — richiede rifattorizzazione di `autoIngest` (oggi per-file, non per-sezione)

### Decisione 5 — Encyclopedia Mode = "un FILE block per heading"
Il prompt di generation (`buildGenerationPrompt`) riceve `strategy: "encyclopedia"` + la `HeadingNode[]` pre-parsed. Istruisce il LLM: "per ogni heading di livello ≥ X, emetti un FILE block `wiki/concepts/<slug>.md` con frontmatter `parent`/`ancestor`/`heading_level`/`heading_path`/`ingest_strategy: encyclopedia`". Il LLM non "decide" i boundary — li riceve deterministici.

### Decisione 6 — Narrative Mode = prompt con divieto esplicito di nodi-capitolo
Il prompt riceve `strategy: "narrative"` + il titolo capitolo come contesto temporale. Istruisce: "NON creare pagine wiki per i capitoli. Estrai solo entità (personaggi, luoghi, eventi) e collegale al grafo esistente."

### Decisione 7 — Cache key estesa, checkpoint invalidato
`ingest-cache.ts` aggiunge `ingestStrategy` alla fingerprint. `LongSourceCheckpoint` (`ingest.ts:185`) aggiunge `ingestStrategy` ai `checkpointParams` — checkpoint pre-feature vengono trattati come incompatibili (re-ingest automatico, sicuro).

### Decisione 8 — Override manuale sempre disponibile, mai default
In Settings una nuova sezione "Ingest Strategy" con toggle: `auto` (default, usa classificatore) / `encyclopedia` / `narrative` / `fixed` (legacy). Quando `auto` e confidenza < 0.80, dialog di conferma con reasoning pre-compilato (Livello 4).

### Deviazioni esplicite dai pattern
Nessuna. Tutti i nuovi moduli seguono i pattern esistenti del codebase: moduli `src/lib/*.ts` puri e testabili, store Zustand in `src/stores/`, sezioni settings in `src/components/settings/sections/` (pattern `output-section.tsx`), tipi in `src/types/`.

---

## Steps

### STEP 1 — Tipi e heading parser
**Cosa**:
- Nuovo `src/types/ingest.ts`: `HeadingNode`, `HeadingNodeType`, `ClassificationResult`, `IngestStrategy`, `IngestStrategyConfig`
- Nuovo `src/lib/heading-parser.ts`: `parseHeadingTree(content): HeadingNode[]` riusando `splitIntoSections` da `text-chunker.ts`
- Estendere `SourceChunk` (`ingest.ts:169`) con `headingPathArray?: string[]`
- Estendere `Chunk` (`text-chunker.ts:67`) con `headingPathArray?: string[]`

**Pattern di riferimento**: `src/lib/text-chunker.ts:163` `splitIntoSections` (heading stack + fence-aware); `src/types/wiki.ts` (tipi minimi, esportati)

**Verifica**: test in `src/lib/heading-parser.test.ts` — parse del compendio Nani produce 270+ `HeadingNode`, gerarchia `parent`/`ancestor` corretta, heading dentro code fence ignorati

**Rollback**: additivo solo — nuovi file e campi opzionali

---

### STEP 2 — Classificatore Livello 1 (euristica)
**Cosa**:
- Nuovo `src/lib/document-classifier.ts`: `heuristicClassify(content): ClassificationResult`
  - Segnali enciclopedia: heading density > 2/100 righe, heading corti < 40 char > 70%, frontmatter YAML, avg content < 800 token
  - Segnali narrativa: pattern `Capitolo|Chapter|Parte|Part \d`, avg content > 2000 token, heading radi < 0.5/100 righe, dialoghi `«..»`/`"..."` frequenti
  - Soglia confidenza 0.80 → applicazione diretta
- Logging del livello usato in `activity-store` (detail del activity item)

**Pattern di riferimento**: `src/lib/detect-language.ts` (euristica pura, deterministica, testabile)

**Verifica**: `src/lib/document-classifier.test.ts` — suite di 10+ fixture di tipo noto (compendio → encyclopedia, romanzo → narrative, API doc → fixed/technical)

**Rollback**: additivo

---

### STEP 3 — Store + UI override (Livello 4)
**Cosa**:
- `src/stores/wiki-store.ts`: aggiungere `ingestStrategyConfig: IngestStrategyConfig` a `WikiState` + `setIngestStrategyConfig`
  - Shape: `{ mode: "auto" | "encyclopedia" | "narrative" | "fixed", lastClassification?: ClassificationResult }`
- Nuovo `src/components/settings/sections/ingest-strategy-section.tsx` (pattern `output-section.tsx`)
- Persistenza via `persist.ts` esistente (come le altre config)
- Nuovo `src/lib/ingest-strategy-dialog.ts`: dialog di conferma per bassa confidenza (Livello 4) con reasoning pre-compilato

**Pattern di riferimento**: `src/components/settings/sections/output-section.tsx`; `src/stores/wiki-store.ts:426` `embeddingConfig` default

**Verifica**: toggle cambia `ingestStrategyConfig.mode`; al reload il valore persiste; dialog mostra reasoning quando confidenza < 0.80

**Rollback**: additivo (campo opzionale con default `auto`)

---

### STEP 4 — Routing della strategia in `autoIngest`
**Cosa**:
- `autoIngestImpl` (`ingest.ts:485`): dopo lettura `sourceContent`, prima del budget check, chiamare `classify(content)` se `mode === "auto"`. Se confidenza < 0.80 e `mode === "auto"`, mostrare dialog (Livello 4) via `src/lib/ingest-strategy-dialog.ts`
- Passare `strategy` a `buildAnalysisPrompt` e `buildGenerationPrompt` come nuovo parametro opzionale
- Per `encyclopedia`: pre-parsare `HeadingNode[]` e iniettarlo nel prompt di generation come "boundary garantiti"
- Per `narrative`: iniettare il heading del capitolo corrente come "contesto temporale, NON entità"
- Cache key in `ingest-cache.ts` estesa con `strategy`

**Pattern di riferimento**: `ingest.ts:770` `computeIngestSourceBudget` (branch condizionale su dimensione); `ingest.ts:808` passaggio di parametri a `buildAnalysisPrompt`

**Verifica**: `src/lib/ingest.scenarios.test.ts` esteso — scenario encyclopedia produce N FILE blocks dove N ≈ numero heading; scenario narrative non produce FILE block con titolo matching `Capitolo \d`

**Rollback**: `strategy` opzionale default `undefined` → comportamento attuale invariato

---

### STEP 5 — Prompt templates per modalità
**Cosa**:
- Estendere `buildGenerationPrompt` (`ingest.ts:1799`) con sezione condizionale `## Ingest Strategy`:
  - `encyclopedia`: "Il documento è strutturato come enciclopedia. Per ogni heading di livello ≥ {{minLevel}} indicato di seguito, emetti ESATTAMENTE un FILE block in `wiki/concepts/<slug>.md`. Frontmatter obbligatorio: `parent`, `ancestor`, `heading_level`, `heading_path`, `ingest_strategy: encyclopedia`. Lista heading pre-parsed: {{HeadingNode[] JSON}}"
  - `narrative`: "Il documento è narrativo. Gli heading sono titoli di capitolo = contesto temporale, NON entità. NON creare pagine wiki per i capitoli. Estrai solo personaggi, luoghi, eventi, oggetti. Heading contesto: {{heading}}"
- Estendere `buildAnalysisPrompt` (`ingest.ts:1747`) con hint sulla strategia
- Frontmatter writer (`ingest.ts:1484` `stampGeneratedFrontmatterDates`): non scrubbare i nuovi campi opzionali `parent`/`ancestor`/`heading_level`/`heading_path`/`ingest_strategy`

**Pattern di riferimento**: `ingest.ts:1813` `buildGenerationPrompt` (composizione condizionale con `.filter(Boolean).join("\n")`); `templates.ts` `readingTemplate` (già ha sezioni narrative)

**Verifica**: test unitari `src/lib/ingest.prompt.test.ts` — snapshot del prompt per ciascuna modalità; `src/lib/frontmatter.test.ts` esteso per preservare i nuovi campi

**Rollback**: prompt additivi, default nessun hint

---

### STEP 6 — Integrazione wiki-schema e page-types
**Cosa**:
- `src/lib/wiki-page-types.ts`: `GENERATION_WIKI_TYPES` già include `concept`. Aggiungere documentazione che encyclopedia mode genera prevalentemente `concept` e `entity`
- `src/lib/wiki-schema.ts` `validateWikiPageRouting`: verificare che `wiki/concepts/<heading-slug>.md` passi (dovrebbe già — `concepts` è già mappato). I nuovi campi frontmatter `parent`/`ancestor` non rompono la validazione (sono opzionali, non validati)
- `src/lib/wiki-graph.ts`: estendere per costruire relazioni gerarchiche `figlio_di` leggendo `parent`/`ancestor` dal frontmatter (per il grafo sigma.js)
- Post-validazione: dopo `writeFileBlocks`, confrontare numero FILE blocks generati vs `HeadingNode[]` (encyclopedia mode). Se drift > 10%, warn l'utente via `activity-store`

**Pattern di riferimento**: `wiki-page-types.ts:13` `WIKI_TYPE_DIRS`; `wiki-schema.ts` `validateWikiPageRouting`

**Verifica**: pagine encyclopedia generate passano `validateWikiPageRouting`; grafo mostra relazioni `figlio_di`

**Rollback**: additivo

---

### STEP 7 — Long-source checkpoint compatibilità
**Cosa**:
- `LongSourceCheckpoint` (`ingest.ts:185`): aggiungere `ingestStrategy: string` ai campi
- `isCompatibleLongSourceCheckpoint` (`ingest.ts:2286`): richiedere `ingestStrategy` matching — checkpoint pre-feature vengono rifiutati → re-ingest automatico (sicuro)
- `analyzeLongSourceInChunks`: passare `strategy` al `checkpointParams`

**Pattern di riferimento**: `ingest.ts:2298` `isCompatibleLongSourceCheckpoint` (già rifiuta checkpoint incompatibili su `targetChars`/`overlapChars`)

**Verifica**: test che checkpoint pre-feature venga rifiutato e re-ingest avvenga

**Rollback**: campo opzionale — checkpoint vecchi rifiutati (re-ingest), nessuna perdita

---

### STEP 8 — Test e benchmark
**Cosa**:
- Fixture documenti: `src/test-helpers/fixtures/ingest-strategy/` — `compendio-nani.md` (estratto), `romanzo-soeliok.md` (estratto), `api-doc.md`
- `src/lib/document-classifier.test.ts`: accuracy su fixture
- Estendere `src/lib/ingest.scenarios.test.ts`: scenario encyclopedia → 200+ FILE blocks; scenario narrative → 0 nodi capitolo
- Estendere `src/lib/ingest.real-llm.test.ts`: test opzionale con LLM reale su Qwen3/DeepSeek (modelli target del brief)
- Asserzioni metriche:
  - `expect(writtenPaths.filter(p => p.startsWith("wiki/concepts/")).length).toBeGreaterThan(200)` (encyclopedia)
  - `expect(writtenPaths.some(p => /capitolo|chapter/i.test(p))).toBe(false)` (narrative)

**Pattern di riferimento**: `src/test-helpers/scenarios/ingest-scenarios.ts`; `src/lib/ingest.real-llm.test.ts`

**Verifica**: `npm run test` verde; metriche (conteggio nodi) nei log

**Rollback**: test additivi

---

### STEP FINAL — Documentation update
**Cosa**:
- Aggiornare `src/lib/templates.ts` — documentare che il template "Reading" ora si attiva automaticamente in narrative mode
- Aggiornare `src/components/settings/sections/ingest-strategy-section.tsx` con testo i18n (pattern `src/i18n/`)
- Nota in `wiki/log.md` o `CHANGELOG` se presente: nuova feature ingest strategy
- Aggiornare `src/lib/wiki-page-types.ts` JSDoc per i nuovi campi frontmatter

**Verifica**: docs riflettono lo stato finale

**Rollback**: docs rollback via git

---

## Ordine di commit suggerito per PR pulita

1. `feat(types): add HeadingNode, ClassificationResult, IngestStrategy types` (STEP 1 tipi)
2. `feat(ingest): add heading-parser.ts reusing text-chunker sections` (STEP 1 parser)
3. `feat(ingest): add document-classifier.ts heuristic level 1` (STEP 2)
4. `feat(store): add ingestStrategyConfig to wiki-store` (STEP 3 store)
5. `feat(ui): add ingest-strategy settings section` (STEP 3 UI)
6. `feat(ingest): route strategy in autoIngest + cache key extension` (STEP 4)
7. `feat(ingest): encyclopedia + narrative prompt templates` (STEP 5)
8. `feat(wiki): preserve hierarchical frontmatter fields` (STEP 5 frontmatter)
9. `feat(graph): build figlio_di relations from parent/ancestor` (STEP 6)
10. `fix(ingest): invalidate long-source checkpoints on strategy change` (STEP 7)
11. `test(ingest): add strategy scenarios + classifier accuracy suite` (STEP 8)
12. `docs: update templates and i18n for ingest strategy` (STEP FINAL)

---

## Analisi avversativa — debolezze del brief e soluzioni

### Verdetto: **Needs revision** (del brief, non del piano)

Il brief è approvabile solo dopo la rettifica architetturale (frontend TS, non Rust). Il piano sopra incorpora già le correzioni. Di seguito le debolezze residue.

### Finding Bloccanti

- **Critica — Premessa architetturale errata**: il brief colloca ingest in Rust; è in TS. Tutti i nuovi file Rust proposti (`heading_parser.rs`, `document_classifier.rs`) sono sbagliati. **Correzione**: riallocare in `src/lib/` TS come da piano. Già applicato.

- **Alta — `pulldown-cmark` inutile e duplicante**: non è dipendenza e il parsing markdown è già in `text-chunker.ts` con regex + fence-awareness. Aggiungerlo a Rust duplicherebbe logica. **Correzione**: niente `Cargo.toml`. Riusare `splitIntoSections`. Già applicato.

- **Alta — Cache invalidazione non affrontata**: `ingest-cache.ts` usa source-content hash come key. Cambiare strategia cambierebbe i file generati ma la cache restituirebbe quelli vecchi. **Correzione**: estendere cache key con `ingestStrategy` (STEP 4). Già applicato.

- **Alta — Long-source checkpoint rompe**: `LongSourceCheckpoint` valida `targetChars`/`overlapChars`. Nuova strategia = nuovi parametri = checkpoint rifiutato, ma il brief non lo menziona. **Correzione**: STEP 7 aggiunge `ingestStrategy` alla validità. Già applicato.

### Finding Non Bloccanti

- **Media — Classificatore LLM (Livello 2) sovraingegnerizzato**: una LLM call per documento a bassa confidenza è costosa e lenta. L'euriistica ben tarata copre la maggioranza dei casi (compendio vs romanzo hanno segnali fortissimi). **Suggerimento**: posticipare Livello 2 a dopo aver misurato l'accuracy di Livello 1 sul corpus reale. Già applicato (Decisione 4).

- **Media — MIXED mode (Livello 3) richiede rifattorizzazione di `autoIngest`**: oggi è per-file. Segmentare per H1 e applicare strategie diverse richiede di spezzare `autoIngestImpl` in un loop per sezione. Complessità alta, ROI incerto. **Suggerimento**: posticipare a Fase 5. Già applicato.

- **Media — "Nodo garantito per heading" vs pipeline FILE-block**: la pipeline attiva genera N FILE blocks LLM-decisi, non 1 per heading deterministico. La mentalità "heading = nodo garantito" richiede di dare al LLM i boundary pre-parsed (Decisione 5). Se il LLM ignora l'istruzione, non c'è garanzia deterministica reale. **Suggerimento**: considerare una post-validazione che conti i FILE blocks vs heading — se drift > 10%, warn l'utente. Aggiunto in STEP 6.

- **Media — Project lock durata**: `withProjectLock` (`ingest.ts:480`) tiene il lock per tutta la durata. Aggiungere la classificazione pre-Step 1 estende la durata del lock di < 5ms (euriistica), ma Livello 2 LLM aggiungerebbe secondi. **Suggerimento**: Livello 2 deve girare fuori dal lock o con lock separato. Conferma per posticipare Livello 2.

- **Media — Schema routing non verificato**: il brief non menziona `validateWikiPageRouting`. Se encyclopedia mode genera path non conformi allo schema del progetto, vengono droppati silenziosamente (`ingest.ts:1577`). **Suggerimento**: STEP 6 verifica. Già applicato.

- **Bassa — Tipi `WikiNode` del brief vs `FileNode` reale**: il brief definisce `HeadingNodeType` enum con `EncyclopediaEntry`/`NarrativeBoundary`, ma il grafo reale usa `FileNode` (`src/types/wiki.ts`) non `WikiNode`. **Suggerimento**: il tipo enum va in `src/types/ingest.ts`, non si tocca `FileNode`.

### Assunzioni da verificare

- **Il LLM rispetta i boundary pre-parsed in encyclopedia mode**: assunto che il prompt "emetti ESATTAMENTE un FILE block per heading" sia seguito. Verificare con test real-LLM (STEP 8 `ingest.real-llm.test.ts`) su Qwen3/DeepSeek. Se drift > 10%, aggiungere post-validazione.
- **L'euriistica distingue correttamente compendio vs romanzo**: i segnali proposti (heading density, lunghezza heading, dialoghi) sono ragionevoli ma non validati sul corpus Soeliok. Verificare con fixture reali (STEP 8).
- **I campi frontmatter `parent`/`ancestor` non rompono `parseFrontmatter`**: `frontmatter.ts` usa `js-yaml` con `JSON_SCHEMA` e normalizza a `Record<string, string|string[]>`. I wikilink `[[...]]` in `parent` sono già gestiti da `repairWikilinkLists`. Verificare con test.

### Test e verifiche mancanti

- **Benchmark conteggio nodi**: il brief chiede "200+ nodi" sul compendio. Non c'è un test automatico che lo verifica. **Aggiungere**: in `ingest.scenarios.test.ts` un'asserzione `expect(writtenPaths.filter(p => p.startsWith("wiki/concepts/")).length).toBeGreaterThan(200)` — ma richiede un estratto del compendio come fixture.
- **Assenza nodi capitolo in narrative**: `expect(writtenPaths.some(p => /capitolo|chapter/i.test(p))).toBe(false)`. Da aggiungere.
- **Compatibilità LLM provider**: il brief menziona OpenRouter/Qwen3/DeepSeek. I test real-LLM esistenti usano Ollama. **Verificare**: estendere i test real-LLM o documentare che la validazione manuale è richiesta.

### Modifiche consigliate al brief (non al piano)

1. **Rettificare §2 "Stack tecnico"**: la pipeline di ingest è TS, non Rust. `pulldown-cmark` va rimosso.
2. **Rettificare §6 "Modifiche ai file esistenti"**: tutti i nuovi file sono in `src/lib/` e `src/types/`, non `src-tauri/src/`.
3. **Aggiungere §6.3 "Cache compatibility"**: estendere `ingest-cache.ts` e `LongSourceCheckpoint`.
4. **Ritirare il riferimento a `commands/llm.rs`** inesistente.
5. **Chiarire §3 Strategia C**: il prompt narrative è già parzialmente coperto dal template "Reading" (`templates.ts:189`) — integrare, non duplicare.

---

*Brief prodotto da ZoneCreative — Giugno 2026*
*Fork: `github.com/zonecreative/llm_wiki` branch `feat/heading-aware-ingest`*
