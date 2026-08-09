# toke-local — Architecture

This document explains how the tool is built and why. It mirrors the public engineering notes on how commercial "token-saving" MCP kits work, but everything here is implemented independently and auditable.

## Principles

1. **Aggregate, don't compress.** The tool never strips information the agent may later need. Instead, it collapses chains of primitive calls (glob → grep → read → …) into single calls whose *output is naturally small* because it embeds only the useful part.
2. **Label every number.** Calls saved → counted. Bytes returned → direct what/whence. Bytes avoided → estimated with a named constant. Assumptions are exported constants, not magic numbers.
3. **Safety before speed.** Edits validate syntax before writing; ambiguity is refused; undefined paths out of scope are rejected; no shell interpolation of user strings; no network calls.
4. **Compounding context.** Every tool call in an agent session re-ingests the growing transcript. Skipping one call makes every later call cheaper — this is why "12 calls → 2" beats "100 KB → 20 KB" compression alone.

## Components

```
bin/toke-local     executable → src/cli.js
src/server.js      MCP: initialize (with steering instructions), tools/list, tools/call, parse errors
src/cli.js         CLI mapping (snake_case arguments between CLI and tool layer)
src/tools/*.js     one file per tool
src/ledger.js      savings ledger persistence + labeled stats
src/syntax.js      per-language validators (TS/JS/JSON/YAML/Python)
src/util.js        tsHeader ("[now: … UTC]"), fuzzy helpers, classifyExt
```

### Tool design notes

- **agent_search** uses `ripgrep` when present (with a plain-JS fallback), normalizes output, ranks matches (exact / word-boundary / basename signals), attaches context before **and after** the match (rg dash-prefix format handled), and builds two import maps: what matched files import, and what imports matched files.
- **agent_read** is intentionally *not* a full parser; it uses brace/paren counting and indentation heuristics for Python/Go/Ruby. Bodies longer than 10 lines are stubbed; imports/types/interfaces/signatures survive.
- **agent_edit** applies edits via the sibling `snapedit` snapshot system (immutable blobs + 3-way merge + atomic write). Fuzzy matching first normalizes whitespace and quotes, then falls back to a compact (space/quote-insensitive) full-line pass; ambiguous hunks are refused.
- **agent_exec** runs commands in a child process with timeout + SIGKILL; the logged output is distilled into a digest that preserves every failure pattern (FAIL/error/stack/trace/WARN) and a summary line; a receipt stores the full output on disk for exact fetch-back. `wait_ms`, `until`, `keep_full`, `digest` switches.
- **agent_git** issues parallel git calls and merges results.
- **agent_savings** records every tool call into an append-only JSON ledger with labels (counted/measured/estimated) and computes derived totals with named constants `BYTES_PER_TOKEN`, `SESSION_CACHE_FACTOR`, `TOKE_RATE_PER_1K`, `CALLS_SAVED_BY_TOOL`.

## MCP protocol behavior

- JSON-RPC 2.0 over stdio, message-per-line framing.
- `initialize` → serverInfo + instructions string steering the agent toward these aggregate tools ("Prefer these aggregate tools over native Glob/Grep/Read/Bash/git chains").
- `tools/list`, `tools/call` for the 6 tools.
- Unknown method → clean JSON-RPC error; malformed JSON → -32700; never crashes.
- Async tools (slow exec) keep writing responses after the input stream closes — verified by test.

## Why zero dependencies

Node ≥18 built-ins (fs, child_process, crypto, path) cover everything. `ripgrep`, `node`, `python3` are *optional runtime* executables discovered at runtime, not npm deps. `typescript` is only used at runtime as an optional parser — if TS is the edit language, it reads tsc via `node --check` fallback.

## Known limitations

See [BENCHMARK.md](./BENCHMARK.md) honestly reproduces the market mechanics but with distinct tool design. Python/Go/Ruby stub correctness depends on indentation heuristics; non-code files bypass structure; the `agent_search` import graph is lexical rather than semantic; and the 20% contract is a modeled requirement, not a certified live-agent measurement.