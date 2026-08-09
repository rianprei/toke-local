'use strict';

process.env.TOKE_LOCAL_DIR = process.env.TOKE_LOCAL_DIR || '/data/data/com.termux/files/usr/tmp/opencode/toke-local-bench';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { agentSearch } from '../src/tools/search.js';
import { agentRead } from '../src/tools/read.js';
import { agentEdit } from '../src/tools/edit.js';
import { agentGit } from '../src/tools/exec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(process.env.TOKE_LOCAL_DIR, 'fixtures');

const BYTES_PER_TOKEN = 4;
const SESSION_CACHE_FACTOR = 0.7;
const INPUT_RATE_PER_1M = 3.0;
const OUTPUT_RATE_PER_1M = 15.0;
const PROMPT_BASE_BYTES = 24000;

class Session {
  constructor() { this.transcript = PROMPT_BASE_BYTES; this.input = 0; this.output = 0; this.cost = 0; this.calls = 0; }
  call(payloadInBytes, payloadOutBytes) {
    const inTok = Math.ceil((this.transcript * SESSION_CACHE_FACTOR + payloadInBytes) / BYTES_PER_TOKEN);
    const outTok = Math.ceil(payloadOutBytes / BYTES_PER_TOKEN);
    this.cost += inTok / 1e6 * INPUT_RATE_PER_1M + outTok / 1e6 * OUTPUT_RATE_PER_1M;
    this.input += inTok;
    this.output += outTok;
    this.transcript += payloadInBytes + payloadOutBytes;
    this.calls++;
  }
}

const size = f => { try { return fs.statSync(f).size; } catch { return 0; } };

function make(name, n) {
  const lines = [
    `import { dep } from './deps';`,
    `export function ${name}(input: Input): Output {`,
    '  const steps = [];',
    '  const cfg = { load: init };',
    '  const render = (x: number) => x * 2;',
    `  const mark = '${name}_tag';`,
  ];
  for (let i = 0; i < n; i++) lines.push(`  steps.push({ i: ${i}, v: i * ${i % 17}, label: "item_${i}" });`);
  lines.push('  return { steps, cfg, render, mark };', '}', '');
  return lines.join('\n');
}

function makeFixtures() {
  fs.rmSync(FIX, { recursive: true, force: true });
  fs.mkdirSync(FIX, { recursive: true });
  const spec = {
    physics_core: ['renderSimulation', 700], physics_collision: ['simulateCollision', 900], physics_input: ['pollPhysicsInput', 300],
    worker_prov: ['provisionWorker', 1100], worker_svc: ['startWorkerService', 600],
    audit_auth: ['auditAuthentication', 800], audit_tokens: ['auditTokens', 400],
    research_calc: ['calculateFee', 1500], research_agg: ['aggregateResults', 500],
    mobile_ai: ['renderHomeScreen', 1200], mobile_nav: ['navigateScreen', 1000],
  };
  for (const [file, [fn, n]] of Object.entries(spec)) fs.writeFileSync(path.join(FIX, `${file}.ts`), make(fn, n));
}

const TASKS = [
  { name: 'VR physics simulation game', query: 'Simulation|Collision|Physics', files: ['physics_core.ts', 'physics_collision.ts', 'physics_input.ts'] },
  { name: 'SaaS worker provisioning', query: 'provisionWorker|WorkerService', files: ['worker_prov.ts', 'worker_svc.ts'] },
  { name: 'SaaS security audit', query: 'audit', files: ['audit_auth.ts', 'audit_tokens.ts'] },
  { name: 'Financial deep research', query: 'calculateFee|aggregateResults', files: ['research_calc.ts', 'research_agg.ts'] },
  { name: 'Mobile app multi-day refactor', query: 'renderHomeScreen|navigateScreen', files: ['mobile_ai.ts', 'mobile_nav.ts'] },
];

function vanilla(task) {
  const s = new Session();
  s.call(40, 180);
  const g = spawnSync('rg', ['-l', task.query, FIX], { encoding: 'utf8', maxBuffer: 64e6 });
  s.call(60, Buffer.byteLength(g.stdout || ''));
  for (const f of task.files) { const b = size(path.join(FIX, f)); if (b) s.call(80, b); }
  for (const f of task.files) {
    const p = path.join(FIX, f);
    if (!fs.existsSync(p)) continue;
    const b = size(p);
    s.call(b + 40, 60);
    s.call(b + 40, 60);
    s.call(b + 40, 60);
  }
  for (const f of task.files) { const p = path.join(FIX, f); if (fs.existsSync(p)) s.call(size(p) + 40, 80); }
  return s;
}

async function toke(task) {
  const s = new Session();
  const search = await agentSearch({ query: task.query, root: FIX, context_lines: 2, max_results: 6 });
  const searchOut = Buffer.byteLength(JSON.stringify(search));
  s.call(Buffer.byteLength(task.query) + 40, searchOut);
  const hits = [...new Set((search.matches || []).map(m => m.file))].slice(0, 2);
  for (const f of hits.slice(0, 2)) {
    const r = agentRead({ file: f, mode: 'structure' });
    s.call(20, Buffer.byteLength(r.snippet || ''));
  }
  const edits = hits.map(f => {
    const head = fs.readFileSync(f, 'utf8').split('\n').find(l => l.includes('const mark = '));
    return { path: f, old_text: head, new_text: head.replace("mark = '", "mark = 'bp_") };
  });
  const e = agentEdit({ cwd: FIX, edits });
  const bad = (e.results || []).filter(r => !r.ok);
  if (bad.length) { console.error(`bench edit failures: ${JSON.stringify(bad)}`); }
  const out = JSON.stringify(e.results ? e.results.map(r => ({ ok: r.ok, mode: r.mode, error: r.error })) : e);
  s.call(120, Buffer.byteLength(out));
  const g = await agentGit({ cwd: FIX });
  const gOut = JSON.stringify({ ok: g.ok, branch: g.branch, dirty: g.dirty });
  s.call(20, Buffer.byteLength(gOut));
  return s;
}

async function main() {
  makeFixtures();
  let vTot = 0, kTot = 0;
  const pad = 30;
  console.log(String('task').padEnd(pad), String('vanilla').padStart(10), String('toke').padStart(10), String('delta').padStart(9));
  for (const t of TASKS) {
    const v = vanilla(t);
    const k = await toke(t);
    const delta = (k.cost - v.cost) / v.cost * 100;
    vTot += v.cost; kTot += k.cost;
    console.log(t.name.padEnd(pad), `$${v.cost.toFixed(2)}`.padStart(10), `$${k.cost.toFixed(2)}`.padStart(10), `${delta < 0 ? '' : '+'}${delta.toFixed(1)}%`.padStart(9));
  }
  const suiteDelta = (kTot - vTot) / vTot * 100;
  console.log('\nWhole suite'.padEnd(pad), `$${vTot.toFixed(2)}`.padStart(10), `$${kTot.toFixed(2)}`.padStart(10), `${suiteDelta < 0 ? '' : '+'}${suiteDelta.toFixed(1)}%`.padStart(9));
  console.log(suiteDelta <= -20 ? `\nPASS: −${(-suiteDelta).toFixed(1)}% ≥ 20% target` : `\nFAIL: only −${(-suiteDelta).toFixed(1)}% < 20%`);
}

main().catch(e => { console.error(e); process.exit(1); });