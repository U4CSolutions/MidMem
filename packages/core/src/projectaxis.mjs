/**
 * Project axis (roadmap 2026-09 #18) — a first-class `project` attribute on entries,
 * ORTHOGONAL to scope. Scope says which agent may read/write an entry (access);
 * project says which body of work it belongs to (partition). NULL project = global.
 *
 * Read rule mirrors scope's own-plus-shared: a project-scoped read returns the
 * project's entries PLUS global ones. A caller with no project set reads everything
 * (the admin/bridge analog). Promotion into a curated-only tier LIFTS an entry to
 * global (project → NULL, lineage kept in provenance.liftedFrom) so cross-project
 * lessons emerge from use instead of being written twice.
 *
 * Deterministic, no policy: any scope may tag any project — access stays scope's job.
 */

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,119}$/;

/** Normalize a project slug: trim; empty/undefined → null (global); invalid → throws. */
export function normalizeProject(p) {
  if (p === undefined || p === null) return null;
  const s = String(p).trim();
  if (!s) return null;
  if (!SLUG_RE.test(s)) throw new Error(`bad project slug: '${s}' (letters, digits, . _ / - ; ≤120 chars; no spaces)`);
  return s;
}

/**
 * Resolve a read-side project selector into a list (or null = no filter).
 *   opts.projects: string[]  explicit list      opts.project: string  single
 *   opts.projects === null   explicit "all"     nothing passed → caller's default
 */
export function resolveProjects(opts = {}, fallback = null) {
  if (opts.projects === null) return null;
  if (Array.isArray(opts.projects)) { const l = opts.projects.map(normalizeProject).filter(Boolean); return l.length ? l : null; }
  if (opts.project !== undefined && opts.project !== null) { const p = normalizeProject(opts.project); return p ? [p] : null; }
  return fallback;
}

/** SQL fragment + params for the project-plus-global read rule (`col` is the qualified column). */
export function projectClause(col, projects, includeGlobal = true) {
  if (!projects || !projects.length) return null;
  const inList = `${col} IN (${projects.map(() => '?').join(',')})`;
  return { sql: includeGlobal ? `(${col} IS NULL OR ${inList})` : inList, params: [...projects] };
}

/** In-memory twin of projectClause for candidates that bypass SQL (concept-routing seeds). */
export function matchesProject(entry, projects, includeGlobal = true) {
  if (!projects || !projects.length) return true;
  const p = entry?.project ?? null;
  if (p === null) return includeGlobal;
  return projects.includes(p);
}
