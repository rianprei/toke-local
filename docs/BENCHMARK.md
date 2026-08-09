# Benchmark methodology

`npm run bench` runs the suite of five tasks (mirroring the categories shown on the commercial product's benchmark page) and reports a vanilla-vs-toke delta. This document explains exactly what is and is not being measured.

```
Whole suite: $11.32 → $0.38 → −96.6%  (5 tasks, measured outputs, named constants)
```

## What runs (steps, both sides)

- **Vanilla path**: glob → grep → full reads of matched files → failed edit → re-read → re-anchor → retry → verify. The failed-edit loop is modeled as 1 failure (exact whitespace mismatch) + re-reads, which is the dominant real-world token burn.
- **toke-local path**: `agent_search` (real tool output measured) → `agent_read` structure on up to 2 matched files (real output) → `agent_edit` batch on all matched files (real result) → `agent_git` (real output). All six tools run in-process against the same scratch repo the vanilla path reads.

## Pricing model (named constants)

```
BYTES_PER_TOKEN        = 4       (US convention on my desktop)
SESSION_CACHE_FACTOR   = 0.7     (transcript re-read costs 70% per call)
INPUT_RATE_PER_1M      = 3.00    (e.g. Sonnet 4 class)
OUTPUT_RATE_PER_1M     = 15.00
PROMPT_BASE_BYTES      = 48000   (sys+context baseline tool layer)
```

Each tool call is charged:

```
input_tokens  = ceil((promptBase·cacheFactor + payloadIn) / bytesPerToken)
output_tokens = ceil(payloadOut / bytesPerToken)
cost          = input·rateIn + output·rateOut
transcript   += payloadIn + payloadOut
```

Because the transcript itself grows, every later call re-pays the earlier payloads — that compound effect is exactly what the aggregation removes.

## Honest boundaries

1. **Measured** = tool outputs (bytes, match lists, diffstats) — collected from actual runs.
2. **Modeled** = the transcript/cost math with the named constants — same as the public methodology.
3. **Not measured here**: real API pricing variance, TLS/provider soak, multi-turn agent reasoning tokens beyond tool I/O, real budget per host. The −96.7% reflects the tool-I/O layer only. A real billed session with an agent will land **below** this number (the commercial site's own live suite reports ~−19.8%); the mechanisms are identical, the measurement basis differs.
4. Variance: simple creation-only tasks (no reads) show near 0% — the savings concentrate where reads/retries/logs dominate, as documented operational guidance.

## Reproducing

```bash
npm run bench
```

Requires `rg`, `python3`, `node` ≥18, git. Ledger goes to `TOKE_LOCAL_DIR` (default `~/.toke-local`); the benchmark uses its own isolated dir via env.