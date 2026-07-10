/**
 * Normalize a path to use forward slashes (works on both macOS and Windows).
 * Windows APIs accept forward slashes, so normalizing to / is safe everywhere.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

/**
 * Join path segments with forward slashes.
 */
export function joinPath(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/\\/g, "/"))
    .join("/")
    .replace(/\/+/g, "/")
}

/**
 * Get the filename from a path (handles both / and \).
 */
export function getFileName(p: string): string {
  const normalized = p.replace(/\\/g, "/")
  return normalized.split("/").pop() ?? p
}

/**
 * Get the file stem (filename without extension).
 */
export function getFileStem(p: string): string {
  const name = getFileName(p)
  const lastDot = name.lastIndexOf(".")
  return lastDot > 0 ? name.slice(0, lastDot) : name
}

/**
 * Get relative path from base.
 */
export function getRelativePath(fullPath: string, basePath: string): string {
  const normalFull = normalizePath(fullPath)
  const normalBase = normalizePath(basePath).replace(/\/$/, "")
  if (normalFull.startsWith(normalBase + "/")) {
    return normalFull.slice(normalBase.length + 1)
  }
  return normalFull
}

/**
 * Cross-platform absolute-path detection.
 *
 * Unix:     "/foo/bar"
 * Windows:  "C:\foo", "C:/foo", "\\server\share", "//server/share"
 *
 * A bare `.startsWith("/")` check wrongly treats Windows paths like
 * "C:/project/file.pdf" as relative, which produced double-joined
 * garbage like "C:/project/C:/project/file.pdf" in the ingest queue.
 */
export function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith("/")) return true
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (p.startsWith("\\\\") || p.startsWith("//")) return true
  return false
}

/** Project-relative path even when absolute paths use a different prefix (symlinks). */
export function projectRelativePath(filePath: string, projectPath: string): string {
  const fp = normalizePath(filePath)
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  if (fp.startsWith(`${pp}/`)) return fp.slice(pp.length + 1)

  const lower = fp.toLowerCase()
  const wikiIdx = lower.indexOf("/wiki/")
  if (wikiIdx >= 0) return fp.slice(wikiIdx + 1)

  const rawIdx = lower.indexOf("/raw/sources/")
  if (rawIdx >= 0) return fp.slice(rawIdx + 1)

  return fp
}

/** Resolve a raw source path to an absolute path under the project. */
export function resolveAbsoluteSourcePath(projectPath: string, sourcePath: string): string {
  const sp = normalizePath(sourcePath)
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  if (isAbsolutePath(sp)) return sp
  if (sp.startsWith("raw/sources/")) return `${pp}/${sp}`
  return `${pp}/raw/sources/${sp}`
}
