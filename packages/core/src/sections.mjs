/**
 * Digest sectioning (2026-10-06). A multi-paper digest ingested as ONE file compresses to one
 * summary: measured 2026-10-05, a six-paper weekly report (304 lines, one `###` per paper, each
 * with its arXiv URL) became a 430-character summary, 8 concepts and 1 claim — "MemAgent", "URAM"
 * and the papers' figures were retrievable by nobody while the grounding score read 0.864 (the
 * summary was faithful; it just kept almost nothing). The fix is deterministic: split on the
 * markdown headings, and a section that cites exactly one source becomes its own grounded ingest,
 * keyed by that citation (Orchestrator.ingestSections). Pure — no I/O, no LLM; same text → same split.
 */

/** URLs in free text: the same pattern the secret-text guard scans with, so a URL the guard would
 *  see is exactly a URL the splitter sees (one rule, two call sites). */
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
/** Sentence/markdown punctuation glued to the end of a URL in prose: `(see https://…).` */
const TRAILING_PUNCT_RE = /[.,;:)\]>'"]+$/;
/** arXiv identifiers: new style (2501.12345, 4–5 digit tail) and old style (hep-th/9901001). */
const ARXIV_ID_RE = /^(\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})$/i;
const ATX_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^ {0,3}(```|~~~)/;

/**
 * The canonical identity of a cited URL, or null for anything that is not an http(s) URL.
 *  - arXiv (`/abs/<id>` or `/pdf/<id>`, any version suffix, `.pdf`, http or https, `www.` or not)
 *    → `https://arxiv.org/abs/<id>` (version stripped: v2 and v3 of one paper are ONE source,
 *    so a revised digest entry supersedes instead of forking) + `docId 'arxiv:<id>'`.
 *  - DOI (`doi.org/<doi>`, `dx.doi.org/<doi>`) → `https://doi.org/<doi>` + `docId 'doi:<doi>'`,
 *    both lower-cased: DOIs are case-insensitive, so case must not split one source in two.
 *  - any other http(s) URL → the URL itself, fragment and trailing prose punctuation stripped,
 *    query kept (it can be identity); no docId.
 */
export function canonicalizeCitation(url) {
  if (typeof url !== 'string') return null;
  let s = url.trim().replace(TRAILING_PUNCT_RE, '');
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash).replace(TRAILING_PUNCT_RE, '');
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'arxiv.org' || host === 'www.arxiv.org') {
    const m = u.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:v\d+)?(?:\.pdf)?\/?$/i);
    if (m && ARXIV_ID_RE.test(m[1])) return { canonicalUri: `https://arxiv.org/abs/${m[1]}`, docId: `arxiv:${m[1]}` };
  }
  if (host === 'doi.org' || host === 'dx.doi.org') {
    let doi = u.pathname.replace(/^\/+/, '');
    try { doi = decodeURIComponent(doi); } catch { /* keep the raw form */ }
    doi = doi.toLowerCase();
    if (/^10\.\S+\/\S+$/.test(doi)) return { canonicalUri: `https://doi.org/${doi}`, docId: `doi:${doi}` };
  }
  return { canonicalUri: s };
}

/** Heading text as a reader sees it: link/image syntax → its text, emphasis/code markers and the
 *  optional closing `#` run dropped. Intra-word underscores (snake_case) are kept. */
function plainHeading(raw) {
  return raw
    .replace(/\s+#+\s*$/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]+|~~/g, '')
    .replace(/(^|[\s(\[])_+|_+(?=[\s)\].,;:!?]|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split markdown into sections on ATX headings (`^#{1,6}\s+`). A section runs from its heading line
 * to the line before the NEXT heading of any level — a sub-heading is its own section and a parent
 * keeps only its own preamble, so a `## Key Papers` wrapper never swallows the papers under it.
 * Lines inside fenced code blocks are never headings (a `# comment` in a shell snippet is not one).
 *
 * Each section: `{ index, heading, level, headingLine, text, citations, qualifies, reason? }` —
 * `heading` is the plain heading text (null for the text before the first heading, which is a
 * section of its own and never qualifies: reason 'preamble'); `text` is the body with the heading
 * line excluded, outer blank lines trimmed; `citations` are the distinct canonical URIs found in
 * the heading line and body, in order of first appearance. A section qualifies when it cites
 * exactly ONE distinct source and its body has at least `minChars` characters; otherwise `reason`
 * is 'no-citation' | 'multiple-citations' | 'too-short' (checked in that order).
 */
export function splitDigestSections(text, { minChars = 200 } = {}) {
  if (typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  const raw = [];
  let cur = { heading: null, level: 0, headingLine: null, body: [] };
  let fence = null;
  for (const line of lines) {
    const f = line.match(FENCE_RE);
    if (f) fence = fence === null ? f[1] : (fence === f[1] ? null : fence);
    const h = fence === null && !f ? line.match(ATX_RE) : null;
    if (h) {
      raw.push(cur);
      cur = { heading: plainHeading(h[2]), level: h[1].length, headingLine: line, body: [] };
    } else cur.body.push(line);
  }
  raw.push(cur);
  const out = [];
  for (const r of raw) {
    const body = r.body.join('\n').trim();
    if (r.heading === null && !body) continue; // no preamble at all
    const citations = [];
    for (const m of `${r.headingLine || ''}\n${body}`.match(URL_RE) || []) {
      const c = canonicalizeCitation(m);
      if (c && !citations.includes(c.canonicalUri)) citations.push(c.canonicalUri);
    }
    let reason = null;
    if (r.heading === null) reason = 'preamble';
    else if (!citations.length) reason = 'no-citation';
    else if (citations.length > 1) reason = 'multiple-citations';
    else if (body.length < minChars) reason = 'too-short';
    out.push({ index: out.length, heading: r.heading, level: r.level, headingLine: r.headingLine, text: body, citations, qualifies: !reason, ...(reason ? { reason } : {}) });
  }
  return out;
}
