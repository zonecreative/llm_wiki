import { readFile, writeFile, fileExists } from "@/commands/fs"
import { normalizePath, isAbsolutePath } from "@/lib/path-utils"

/**
 * SHA256-based ingest cache.
 * Stores hash of source file content → skips re-ingest if unchanged.
 * Cache file: .llm-wiki/ingest-cache.json
 */

/**
 * Pipeline version — bumped when the ingest prompt logic, heading
 * parser, or classification algorithm changes in a way that would
 * produce different output for the same input. This is mixed into
 * the cache hash so old entries auto-invalidate without requiring
 * the user to manually clear caches.
 *
 * Bump this when:
 *   - The encyclopedia/narrative prompt templates change significantly
 *   - The heading classification algorithm changes (e.g. new structural
 *     folding logic, new content threshold)
 *   - The slug computation rule changes
 *   - The parent-child linking logic changes
 */
export const INGEST_PIPELINE_VERSION = "8"

interface CacheEntry {
  hash: string
  timestamp: number
  filesWritten: string[]
}

interface CacheData {
  entries: Record<string, CacheEntry> // keyed by source filename
}

async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Compute the cache hash for a source file. Includes:
 *   - The pipeline version (bumps when prompt/classification logic changes)
 *   - The ingest strategy (encyclopedia/narrative/fixed)
 *   - The source content
 *
 * This ensures that ANY change to the ingest pipeline invalidates the
 * cache automatically — the user never needs to manually clear it.
 */
async function computeCacheHash(
  sourceContent: string,
  ingestStrategy?: string,
  slugMode?: string,
  slugNamespace?: string,
): Promise<string> {
  const parts = [
    `v=${INGEST_PIPELINE_VERSION}`,
    ingestStrategy ? `strategy=${ingestStrategy}` : "",
    slugMode ? `slugMode=${slugMode}` : "",
    slugNamespace ? `slugNs=${slugNamespace}` : "",
    sourceContent,
  ].filter(Boolean)
  return sha256(parts.join("\n"))
}

function cachePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-cache.json`
}

async function loadCache(projectPath: string): Promise<CacheData> {
  try {
    const raw = await readFile(cachePath(projectPath))
    return JSON.parse(raw) as CacheData
  } catch {
    return { entries: {} }
  }
}

async function saveCache(projectPath: string, cache: CacheData): Promise<void> {
  try {
    await writeFile(cachePath(projectPath), JSON.stringify(cache, null, 2))
  } catch {
    // non-critical
  }
}

/**
 * Check if a source file has already been ingested with the same content.
 * Returns the list of previously written files if cached, or null if ingest
 * is needed.
 *
 * IMPORTANT: a cache hit is only returned if every previously-written file
 * still exists on disk. Otherwise we treat the cache as stale and fall
 * through to a full re-ingest. Historically we returned the cached list
 * blindly, which surfaced ghost entries in the activity panel — clicking
 * them gave the preview panel a missing file, and the auto-save path then
 * materialized a `[Binary file: ...]` stub at the now-empty location.
 *
 * When `ingestStrategy` is provided, it is mixed into the hash so that
 * changing strategy (e.g. from fixed to encyclopedia) invalidates the
 * cache and triggers a full re-ingest with the new strategy.
 */
export async function checkIngestCache(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
  ingestStrategy?: string,
  slugMode?: string,
  slugNamespace?: string,
): Promise<string[] | null> {
  const cache = await loadCache(projectPath)
  const entry = cache.entries[sourceFileName]
  if (!entry) return null

  const currentHash = await computeCacheHash(sourceContent, ingestStrategy, slugMode, slugNamespace)
  if (entry.hash !== currentHash) return null

  const pp = normalizePath(projectPath)
  for (const filePath of entry.filesWritten) {
    const fullPath = isAbsolutePath(filePath)
      ? normalizePath(filePath)
      : `${pp}/${filePath}`
    try {
      if (!(await fileExists(fullPath))) {
        console.log(
          `[ingest-cache] cache miss for ${sourceFileName}: ${filePath} no longer on disk`,
        )
        return null
      }
    } catch {
      // If the existence check itself fails, fall back to re-ingest —
      // safer than trusting a stale cache entry.
      return null
    }
  }

  return entry.filesWritten
}

/**
 * Save ingest result to cache after successful ingest.
 *
 * When `ingestStrategy` is provided, it is mixed into the hash so the
 * cache entry is tied to the strategy used. A future ingest with a
 * different strategy will produce a different hash and miss.
 */
export async function saveIngestCache(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
  filesWritten: string[],
  ingestStrategy?: string,
  slugMode?: string,
  slugNamespace?: string,
): Promise<void> {
  const cache = await loadCache(projectPath)
  const hash = await computeCacheHash(sourceContent, ingestStrategy, slugMode, slugNamespace)
  const newEntries = { ...cache.entries }
  newEntries[sourceFileName] = {
    hash,
    timestamp: Date.now(),
    filesWritten,
  }
  await saveCache(projectPath, { entries: newEntries })
}

/**
 * Remove a source file entry from cache (e.g., when source is deleted).
 */
export async function removeFromIngestCache(
  projectPath: string,
  sourceFileName: string,
): Promise<void> {
  const cache = await loadCache(projectPath)
  const newEntries = { ...cache.entries }
  delete newEntries[sourceFileName]
  await saveCache(projectPath, { entries: newEntries })
}
