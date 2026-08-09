'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DIR = process.env.TOKE_LOCAL_DIR || path.join(os.homedir(), '.toke-local');

// Every assumption is a named constant (spec: all assumptions named).
export const TOKE_RATE_PER_1K = 0.000003; // USD per 1k tokens, $3/M tokens blended (posted list rates)
export const BYTES_PER_TOKEN = 4;         // rough token estimate for mixed text/code
export const SESSION_CACHE_FACTOR = 0.7;  // share of output tokens re-ingested per later call

// Counted calls avoided per tool call (aggregation constant, see doc).
export const CALLS_SAVED_BY_TOOL = {
  agent_search: 5,   // glob + grep + read + import analysis + re-check
  agent_read: 1,     // one structured read replaces full dump
  agent_edit: 2,     // failed edit retry + re-anchor read
  agent_exec: 2,     // run + grep/tail chain
  agent_git: 6,      // status + branch + log + diff + stash + remote
  agent_savings: 0,
};

export class Ledger {
  constructor(dir = DEFAULT_DIR) {
    this.dir = dir;
    this.file = path.join(dir, 'savings.json');
    this.logDir = path.join(dir, 'logs');
    this._ensure();
    this.data = this._load();
  }

  _ensure() {
    fs.mkdirSync(this.logDir, { recursive: true });
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, JSON.stringify({ version: 2, entries: [] }));
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { version: 2, entries: [] }; }
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }

  record(tool, { inputBytes = 0, outputBytes = 0, avoidedBytes = 0, callsSaved = 0, note = '' } = {}) {
    const saved = callsSaved || CALLS_SAVED_BY_TOOL[tool] || 0;
    this.data.entries.push({
      ts: new Date().toISOString(), tool, input_bytes: inputBytes, output_bytes: outputBytes,
      avoided_bytes: avoidedBytes, calls_saved: saved, note,
    });
    if (this.data.entries.length > 10000) this.data.entries = this.data.entries.slice(-5000);
    this._save();
  }

  stats({ days } = {}) {
    const cutoff = days ? Date.now() - days * 86400 * 1000 : null;
    const entries = cutoff ? this.data.entries.filter(e => new Date(e.ts).getTime() >= cutoff) : this.data.entries;
    const totals = { calls: 0, input_bytes: 0, output_bytes: 0, avoided_bytes: 0, calls_saved: 0 };
    const byTool = {};
    for (const e of entries) {
      totals.calls++;
      totals.input_bytes += e.input_bytes;
      totals.output_bytes += e.output_bytes;
      totals.avoided_bytes += e.avoided_bytes;
      totals.calls_saved += e.calls_saved;
      byTool[e.tool] = byTool[e.tool] || { calls: 0, output_bytes: 0, avoided_bytes: 0, input_bytes: 0, calls_saved: 0 };
      const t = byTool[e.tool];
      t.calls++; t.input_bytes += e.input_bytes; t.output_bytes += e.output_bytes;
      t.avoided_bytes += e.avoided_bytes; t.calls_saved += e.calls_saved;
    }
    const estTokens = Math.ceil((totals.output_bytes + totals.input_bytes) / BYTES_PER_TOKEN);
    const estUsd = +(totals.output_bytes / 1000 * TOKE_RATE_PER_1K).toFixed(4);
    const avoidedTokens = Math.ceil(totals.avoided_bytes / BYTES_PER_TOKEN);
    const estSpendAvoided = +(avoidedTokens / 1000 * TOKE_RATE_PER_1K * SESSION_CACHE_FACTOR).toFixed(6);
    return {
      totals: { ...totals, est_tokens: estTokens, est_usd: estUsd, est_tokens_avoided: avoidedTokens, est_spend_avoided: estSpendAvoided },
      by_tool: byTool,
      // every number labeled for what it is (site contract)
      labels: {
        calls: 'counted',
        calls_saved: 'counted (per-tool constant)',
        input_bytes: 'measured',
        output_bytes: 'measured',
        avoided_bytes: 'estimated',
        est_tokens: 'estimated',
        est_usd: 'estimated (priced from posted list rates, session-cache factored)',
        est_tokens_avoided: 'estimated',
        est_spend_avoided: 'estimated (priced from posted list rates, session-cache factored)',
      },
      constants: {
        TOKE_RATE_PER_1K,
        BYTES_PER_TOKEN,
        SESSION_CACHE_FACTOR,
        CALLS_SAVED_BY_TOOL,
      },
    };
  }

  writeLog(id, content) {
    fs.writeFileSync(path.join(this.logDir, id + '.log'), content);
    return path.join(this.logDir, id + '.log');
  }

  readLog(id) {
    const p = path.join(this.logDir, id + '.log');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }

  logList() {
    try {
      return fs.readdirSync(this.logDir).filter(f => f.endsWith('.log')).map(f => ({
        id: f.replace(/\.log$/, ''), bytes: fs.statSync(path.join(this.logDir, f)).size,
      })).sort((a, b) => b.bytes - a.bytes);
    } catch { return []; }
  }
}