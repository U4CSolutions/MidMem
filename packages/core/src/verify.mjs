/**
 * SigmaVerifier — deterministic structural checks over the SINGLE graph/entries
 * (the scaffold built a throwaway third graph). Detects identity duplicates and
 * direct (negation) contradictions, with proof receipts to the audit table.
 * Heuristic by design at this phase; LLM-assisted verification is a later seam.
 */
import { nowISO, sha, tokenize } from './util.mjs';

const NEGATIONS = ['not', 'never', 'no', 'cannot', 'without', 'false', 'incorrect', 'wrong', 'invalid', 'untrue', 'lacks', 'absent'];

function jaccard(a, b) {
  const A = new Set(tokenize(a)), B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / new Set([...A, ...B]).size;
}
const stripNeg = (s) => { let t = ' ' + s.toLowerCase() + ' '; for (const n of NEGATIONS) t = t.replaceAll(` ${n} `, ' '); return t; };

export class SigmaVerifier {
  /** @param {import('./db.mjs').StateDB} db @param {import('./graph.mjs').GraphStore} graph */
  constructor(db, graph, cfg) { this.db = db; this.graph = graph; this.cfg = cfg; }

  /** Check new concepts against existing graph nodes for identity collisions. */
  verifyConcepts(concepts = []) {
    const conflicts = [];
    for (const c of concepts) {
      for (const n of this.graph.byType(c.type || 'concept')) {
        if (n.label.toLowerCase() === c.name.toLowerCase()) continue;
        const sim = jaccard(c.name, n.label);
        if (sim > 0.7) conflicts.push({
          type: 'identity', a: c.name, b: n.label,
          detail: `possible duplicate concept (sim ${sim.toFixed(2)})`, severity: sim > 0.9 ? 'high' : 'medium',
        });
      }
    }
    return this.#finish(conflicts, concepts.map((c) => `${c.type || 'concept'}:${String(c.name).toLowerCase()}`), 'concepts');
  }

  /** Scan active entries for direct contradictions (negation-difference + overlap). */
  detectConflicts({ max = 150 } = {}) {
    const rows = this.db.prepare("SELECT id,content FROM entries WHERE status='active' LIMIT ?").all(max);
    const conflicts = [];
    for (let i = 0; i < rows.length; i++)
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j];
        const aNeg = NEGATIONS.some((n) => ` ${a.content.toLowerCase()} `.includes(` ${n} `));
        const bNeg = NEGATIONS.some((n) => ` ${b.content.toLowerCase()} `.includes(` ${n} `));
        if (aNeg === bNeg) continue;
        const sim = jaccard(stripNeg(a.content), stripNeg(b.content));
        if (sim > 0.6) conflicts.push({
          type: 'direct', a: a.id, b: b.id,
          detail: `negation mismatch with ${(sim * 100).toFixed(0)}% overlap`, severity: sim > 0.8 ? 'high' : 'medium',
        });
      }
    return this.#finish(conflicts, rows.map((r) => r.id), 'entries');
  }

  /** The proof binds to WHAT was checked, not only to what failed. Until 2026-09-23 the hash covered
   *  the conflict list alone, so every clean run hashed the same string (206 of 242 audit rows shared
   *  one hash) and the receipt could not tell one clean check from another. Deterministic: the same
   *  checked set with the same outcome always yields the same hash. */
  #finish(conflicts, checkedKeys, kind) {
    const proofHash = sha(JSON.stringify({ kind, checked: [...checkedKeys].sort(), conflicts: conflicts.map((c) => `${c.type}:${c.a}:${c.b}`).sort() }));
    this.db.recordAudit('verify', proofHash, { kind, checked: checkedKeys.length, conflicts });
    return { conflicts, verified: conflicts.length === 0, checked: checkedKeys.length, proofHash, timestamp: nowISO() };
  }
}
