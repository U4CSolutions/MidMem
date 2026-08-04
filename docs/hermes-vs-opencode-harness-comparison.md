# Hermes vs OpenCode: Engineering Harness Comparison

> Research note — 2026-07-13. Based on MEMORY.md canonical config, the Systima token-overhead article, and direct knowledge of both stacks.

## 1. Architecture

| Aspect | Hermes | OpenCode |
|--------|--------|----------|
| **Type** | Multi-agent orchestration framework (Nous Research) | Terminal-based coding agent (open-source) |
| **Communication** | ACP (Agent Communication Protocol) over stdio | Direct API calls to model providers |
| **Agent model** | gpt-5.5 (frontier) + qwen profile (build-labor) | Varies — uses whatever model you configure |
| **Orchestration** | Kanban boards, swarm workers, built-in QA tier | Single-agent with subagent fan-out |
| **Session model** | Persistent sessions with resume (`resumeSessionId`) | Ephemeral per-invocation |
| **MCP** | Flat config in `config.yaml` (command + args) | Built-in MCP server support with schema injection |

**Key difference:** Hermes is a *multi-agent framework* that orchestrates workers across ACP. OpenCode is a *single-agent harness* that can fan out to subagents. This means Hermes's baseline overhead is per-worker, not per-session.

## 2. Token Overhead (from Systima data + our config)

### Baseline overhead (before user prompt arrives)

| Component | Claude Code | OpenCode | Hermes (estimated) |
|-----------|-------------|----------|-------------------|
| System prompt | ~33K | ~7K | ~10-15K |
| Tool schemas (MCP) | +5-7K (5 servers) | included in baseline | +5-7K (5 servers) |
| Instruction file | +20K (72KB AGENTS.md) | +20K | +20K (AGENTS.md + config) |
| **Total before prompt** | **~75-85K** | **~7-10K** | **~35-42K** |

**Hermes sits between Claude Code and OpenCode.** The ACP bridge adds overhead (the `hermes --yolo acp` wrapper, ACP protocol framing, and the `hermes-frontier` agent's own system prompt). But Hermes's base system prompt is leaner than Claude Code's 33K.

### Cache behavior

- **OpenCode:** Byte-identical request prefix across runs → pays cache once, reads back pennies. This is the gold standard.
- **Hermes:** The ACP bridge and per-worker spawning means the request prefix is *not* byte-identical across turns. Each ACP spawn creates a new session with its own framing. This is the **biggest cost disadvantage** vs OpenCode.
- **Claude Code:** Worst — rewrites tens of thousands of cache tokens mid-session, up to 54x more cache writes than OpenCode.

## 3. Subagent Fan-out Costs

### OpenCode
- A 121K-token task done directly → **513K** when fanned to two subagents
- Each subagent re-reads its full system prompt + tools on every turn
- Parent ingests only the returned result, not the full transcript

### Hermes
- Each kanban worker is a separate ACP session → same per-worker baseline cost
- Workers are **profiled** (qwen for build, gpt5 for QA) → different baseline per role
- The kanban orchestrator (gpt-5.5) maintains state across workers → less redundant context than OpenCode's flat fan-out
- **Net:** Hermes's multi-profile approach means *different* baselines per worker type, but the kanban orchestrator's persistent state reduces total redundancy vs OpenCode's flat subagent model.

## 4. Instruction File Weight

Both stacks read instruction files (AGENTS.md, CLAUDE.md, etc.) on every turn:

- **72KB file → ~20K tokens** per request (Systima measurement)
- This is **identical** for both — it's a model-layer cost, not a harness cost
- **Hermes advantage:** Workers can have *different* instruction files per profile, allowing leaner per-role prompts
- **OpenCode advantage:** Single instruction file, no per-worker duplication

## 5. MCP Integration

| Aspect | Hermes | OpenCode |
|--------|--------|----------|
| Config | Flat YAML block in `config.yaml` | Built-in, CLI-driven |
| Schema injection | Adds 5-7K tokens (5 servers) | Adds 5-7K tokens (same) |
| Server management | Manual (systemd + flat config) | Automated (discovery + lifecycle) |
| **Net cost impact** | Same as OpenCode (~5-7K for 5 servers) | Same as Hermes |

## 6. Overall Cost Efficiency

### When Hermes wins:
- **Multi-role tasks:** Kanban boards with specialized workers (qwen for build, gpt5 for QA) mean each worker uses only the tools and context it needs
- **Persistent state:** Kanban boards, todo lists, and session resume mean less re-contextualization across turns
- **QA integration:** Built-in verification tier (gpt5) without external tooling

### When OpenCode wins:
- **Single-task efficiency:** Lower baseline overhead (~7K vs ~35-42K for Hermes)
- **Cache efficiency:** Byte-identical prefixes → near-zero marginal cache cost
- **Simplicity:** No ACP bridge overhead, no multi-agent coordination tax

### The verdict:
- **For a single coding task:** OpenCode is ~5-6x more token-efficient on baseline overhead
- **For multi-step builds with QA:** Hermes's kanban architecture can be more efficient because persistent state reduces redundant context
- **For cache-sensitive workloads:** OpenCode wins decisively (byte-identical prefixes)
- **For multi-model orchestration:** Hermes is purpose-built for this; OpenCode requires external orchestration

## 7. Hidden Costs

### Hermes
- ACP bridge overhead per spawn (~5-10K tokens per worker)
- Multi-agent coordination (kanban orchestrator maintains its own context)
- Profile switching (different models = different baselines)
- **But:** Persistent kanban state means less re-sending of context across turns

### OpenCode
- Subagent fan-out multiplies baselines (121K → 513K for 2 subagents)
- No persistent state between invocations
- Every turn re-pays the baseline (even with caching)

## 8. Summary Matrix

| Metric | Hermes | OpenCode | Winner |
|--------|--------|----------|--------|
| Baseline overhead | ~35-42K | ~7-10K | OpenCode |
| Cache efficiency | Moderate | Excellent | OpenCode |
| Multi-task efficiency | High (kanban state) | Low (flat fan-out) | Hermes |
| Multi-model support | Built-in (profiles) | External config | Hermes |
| QA integration | Built-in tier | External | Hermes |
| Per-task cost (single) | Higher | Lower | OpenCode |
| Per-project cost (multi) | Lower (stateful) | Higher (redundant) | Hermes |
| Complexity | High | Low | OpenCode |

## 9. Key Takeaway

Hermes and OpenCode optimize for different things:

- **OpenCode** is a lean single-agent harness that minimizes per-task token cost. It's the right tool when you want maximum efficiency for individual tasks.
- **Hermes** is a multi-agent orchestration framework that minimizes *project-level* cost through persistent state and specialized workers. It's the right tool when you need structured multi-step workflows with built-in QA.

The Systima article's finding that "Claude Code sends 4.7x more tokens than OpenCode before reading your prompt" (33K vs 7K) puts Hermes in an interesting middle ground: ~5x OpenCode's baseline, but ~0.2x Claude Code's. That's not great for single-task efficiency, but the kanban architecture's persistent state can offset this over multi-step projects.

---

*Sources: Systima article (ingested 2026-07-13), MEMORY.md canonical config, direct knowledge of both stacks.*
