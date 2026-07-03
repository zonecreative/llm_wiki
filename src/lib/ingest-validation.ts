/**
 * Post-generation validation helpers for ingest strategies.
 */

export const SOURCE_SUMMARY_MIN_WIKILINKS = 3

const BODY_WIKILINK_RE = /\[\[([^\]]+)\]\]/g
const CHAPTER_PAGE_SLUG_RE = /(?:^|\/)(?:capitolo|chapter|parte|part)-(?:\d+|[ivxlcdm]+)(?:[-.]|$)/i

/** Count [[wikilink]] occurrences in markdown body (excludes frontmatter). */
export function countBodyWikilinks(content: string): number {
  const body = content.replace(/^---[\s\S]*?---\s*/m, "")
  return [...body.matchAll(BODY_WIKILINK_RE)].length
}

export function validateSourceSummaryHub(
  content: string,
  minLinks: number = SOURCE_SUMMARY_MIN_WIKILINKS,
): { ok: boolean; count: number } {
  const count = countBodyWikilinks(content)
  return { ok: count >= minLinks, count }
}

/** Paths that look like undesired chapter/part wiki pages in narrative mode. */
export function findUndesiredChapterPages(paths: string[]): string[] {
  return paths.filter((p) => CHAPTER_PAGE_SLUG_RE.test(p.replace(/\\/g, "/")))
}
