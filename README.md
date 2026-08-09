# toke-local

A local, zero-dependency MCP server that cuts the round-trips, re-reads and log floods out of coding agents — the same tool-aggregation model published by the commercial **Tokeasy** (tokeasy.net), implemented from scratch, auditable, and fully local.

```
12 calls  →  glob → grep → read → read → read → edit ✕ → re-read → retry → verify…
2 calls   →  agent_search → agent_edit
```

Every savings number is labeled **counted / measured / estimated** and every pricing assumption is a named constant in source.

## Features

| Tool | What it does | Saves |
|---|---|---|
| `agent_search` | glob + grep + read + import graph in **one ranked call**: matches with score, context lines, per-file `imports` **and reverse `imported_by`** | 4–5 calls → 1 |
| `agent_read` | structure-aware truncation: imports/types/interfaces/signatures kept, long bodies stubbed (`[body omitted: N lines]`); `mode:"full"` for the whole file | full-file dumps → ~10–20% of bytes |
| `agent_edit` | batched, multi-file edits; fuzzy match tolerates whitespace and quote drift; **TS/JSON/YAML/Python validated before any write**; invalid output rejected, ambiguous hunks refused | failed-edit re-read + retry loops |
| `agent_exec` | accepted command → failure-preserving digest: exit code, **all** failure lines, per-line ~200-char cap, receipt stored for exact fetch-back; `wait_ms` and `until:regex`; timeout kills | 100 KB log → ~2 KB digest |
| `agent_git` | branch, upstream, remote, ahead/behind, dirty, files changed, diffstat, recent commits, stash, merge state in one call | 5+ git calls → 1 |
| `agent_savings` | persistent ledger with labeled totals (counted/measured/estimated), estimate, receipts, reset | transparency (measure, don't guess) |
| `[now: … UTC]` | every response stamps the clock, so the agent stops wasting a call asking the date | 1 call per session |

Plus safety: edits are applied snapshot-safe (immutable blob + 3-way merge + atomic write via the sibling `snapedit` project), path traversal (`../`) and symlink escapes are blocked with `out_of_scope`, and no code ever leaves your machine.

## Benchmark

`npm run bench` reproduces the site's five benchmark categories (VR physics, worker provisioning, security audit, financial research, mobile refactor) with **real tool outputs measured end-to-end** and the session-transcript economics modeled with named constants:

| Task | Vanilla | toke-local | Δ |
|---|---|---|---|
| VR physics simulation game |  $3.00 | $0.08 | −97.4% |
| SaaS worker provisioning     | $1.99 | $0.07 | −96.2% |
| SaaS security audit          | $1.46 | $0.07 | −94.9% |
| Financial deep research      | $2.40 | $0.07 | −96.9% |
| Mobile app multi-day refactor | $2.46 | $0.07 | −97.0% |
| **Whole suite** | **$11.32** | **$0.38** | **−96.6%** |

> **Honest caveat:** this is a *modeled* benchmark (local measured tool outputs + published list-price constants), not a billed agent session. Real-world savings depend on how read/retry-heavy the workload is — the same mechanisms the commercial product documents as ~20% on its own suite. The happy-path claim is: **architecturally the identical cost drivers are removed**, measured locally rather than published by a committee. See [docs/BENCHMARK.md](docs/BENCHMARK.md).

## Install

Requires Node ≥ 18. No runtime dependencies.

```bash
git clone https://github.com/rianprei/toke-local
cd toke-local
```

### Connect to any MCP client

The server speaks **JSON‑RPC 2.0 over stdio**. Point Claude Code, Codex, opencode, Cursor, Copilot or Windsurf at:

```bash
node bin/toke-local mcp
```

Claude Code example:

```bash
claude mcp add toke-local -- npx -y github:rianprei/toke-local -- mcp   # or: node /abs/path/bin/toke-local mcp
```

### CLI

```
toke-local mcp | search | read | edit | exec | git | savings [json-args]
```

Example:

```bash
node bin/toke-local search '{"query":"renderInvoice","root":".","context_lines":2}'
node bin/toke-local read '{"file":"src/invoice.ts"}'
node bin/toke-local edit '{"cwd":".","edits":[{"path":"src/invoice.ts","old_text":"…","new_text":"…"}]}'
```

## Tests

```bash
npm test        # 25/25 pass (node:test, zero deps)
npm run bench   # the benchmark above
```

## Repository layout

```
bench/bench.js         benchmark harness (5 tasks, vanilla vs toke, named constants)
bin/toke-local         executable entry point
src/server.js          MCP JSON‑RPC server (initialize, tools/list, tools/call)
src/cli.js             CLI dispatch
src/tools/             the six tools
src/ledger.js          savings ledger (labeled) with named constants
src/syntax.js          validators (TS/JS/JSON/YAML/Python)
src/util.ts            tsHeader + small helpers
test/toke-local.test.js  25 tests
docs/                   architecture, benchmark methodology, runbook
```

## License

MIT © 2026 rianprei — see [LICENSE](LICENSE). Built to be the open, local, auditable alternative to a closed commercial MCP kit. Code never leaves your machine.