---
name: midmem-pattern-capture
description: Capture architecture/coding patterns, reusable scaffolding, anti-patterns and recipes into MidMem via capture packs — at the moment a build proves them. Use after a build/QA gate passes ("record this pattern", "capture the scaffold", "remember this anti-pattern") or when a repeated approach keeps working across projects.
---

# Pattern capture — record what builds prove

Capture packs make MidMem domain-extensible as data: a pack registers entry types (with a
persistence tier + memory function + graph edge), categorizer rules and an edge vocabulary.
The shipped `coding-patterns` pack covers: `pattern`, `scaffold`, `anti-pattern`, `recipe`
(all procedural-function, memory-tier).

## When to capture
- **At the moment of proof, not from memory:** a card/QA gate just passed using an approach
  worth reusing → record it NOW with its evidence link (commit hash, repo, card id).
- A debugging approach failed for a reproducible reason → `anti-pattern` with the failure as
  evidence. Dead ends prevent repeats; that is their entire value.
- The same scaffold got copied into a second project → `scaffold`, evidence both repos.

## How
```
midmem pattern --type pattern --title "<short name>" \
  --context "<where this applies>" --problem "<what it solves>" \
  --solution "<the approach>" --evidence "<repo@hash;card-id>" [--scope shared]
```
(MCP: `record_pattern`; list registered types with `midmem packs`.)

## Rules
- **Evidence is required in spirit:** a pattern without a commit/repo/run reference is an
  opinion. Link the proof.
- **Never hand-promote.** Patterns start at memory tier; retrieval renewals during later
  builds are what earn wisdom. A "best practice" nobody re-uses should decay.
- **Anti-patterns are captures, not shame:** record the failure mode plainly; the
  dead-end demotion in retrieval surfaces them as warnings automatically.
- New domains = new pack JSON (entry types + rules + edges), registered via
  `MIDMEM_CAPTURE_PACKS` — never a core code change. Packs cannot redefine core types.
