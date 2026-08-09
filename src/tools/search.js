'use strict';

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findFiles, tsHeader } from '../util.js';
import { Ledger } from '../ledger.js';

let RG_BINARY = 'rg';
try {
  execFileSync('rg', ['--version'], { stdio: 'pipe' });
} catch {
  RG_BINARY = null;
}

function runRg(query, root, opts) {
  return new Promise((resolve) => {
    const args = ['--line-number', '--no-heading', '--color', 'never', '-C', String(opts.context || 1), '-e', query, root];
    if (opts.file_pattern) args.splice(args.length - 2, 0, '-g', opts.file_pattern);
    execFile('rg', args, { maxBuffer: 32 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
      if (err && err.code !== 1 && err.code !== 2) resolve({ ok: false, error: String(err.message) });
      else resolve({ ok: true, text: stdout || '' });
    });
  });
}

function fallbackSearch(query, root, opts) {
  const files = findFiles(root, { ignoreDirs: ['node_modules', '.git', 'target', 'dist', 'build', '.venv', '__pycache__'] });
  const out = [];
  for (const f of files) {
    if (opts.file_pattern && !new RegExp(opts.file_pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).test(f)) continue;
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(query)) out.push({ file: f, line: i + 1, text: lines[i] });
      }
    } catch {}
  }
  return { ok: true, text: out.map(m => `${m.file}:${m.line}:${m.text}`).join('\n') };
}

function parseRgOutput(text, context) {
  const matches = [];
  let current = null;
  const pending = [];
  for (const line of text.split('\n')) {
    if (!line || /^--$/.test(line)) continue;
    const mm = line.match(/^(.*?):(\d+):(.*)$/s);
    if (mm) {
      current = { file: path.resolve(mm[1]), line: Number(mm[2]), text: mm[3].trim(), context_lines: [] };
      for (const p of pending) {
        if (current && path.resolve(p.file) === current.file) current.context_lines.push(p.text);
      }
      pending.length = 0;
      matches.push(current);
      continue;
    }
    const cm = line.match(/^(.*)-(\d+)-(.*)$/s);
    if (!cm) continue;
    const cf = path.resolve(cm[1]);
    if (current && cf === current.file) current.context_lines.push(cm[3].trim());
    else pending.push({ file: cf, text: cm[3].trim() });
  }
  return matches;
}

export async function agentSearch({ query, root = process.cwd(), max_results = 12, context_lines = 1, file_pattern }) {
  const resolved = path.resolve(root);
  let res;
  if (RG_BINARY) res = await runRg(query, resolved, { context: context_lines, file_pattern });
  else res = fallbackSearch(query, resolved, { context: context_lines, file_pattern });

  if (!res.ok) return { ok: false, error: 'search_failed', message: res.error };

  const raw = parseRgOutput(res.text, context_lines);

  const ql = query.toLowerCase();
  const scored = raw.map(m => {
    let score = 0;
    const t = m.text.toLowerCase();
    if (t.includes(ql)) score += 2;
    if (new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(m.text)) score += 3;
    if (path.basename(m.file).toLowerCase().includes(ql.replace(/\.|\s/g, ''))) score += 1;
    return { ...m, score };
  }).sort((a, b) => b.score - a.score).slice(0, max_results);

  const files = [...new Set(scored.map(m => m.file))];
  const imports = {};
  for (const f of files) {
    const imp = extractImports(f);
    if (imp.length) imports[f] = imp;
  }
  const imported_by = {};
  if (files.length) {
    for (const f of findFiles(resolved, {})) {
      const imp = extractImports(f);
      if (!imp.length) continue;
      for (const tgt of files) {
        const tBase = path.basename(tgt).replace(/\.[^.]+$/, '');
        if (imp.some(l => l.includes(tBase))) {
          (imported_by[tgt] = imported_by[tgt] || []).push(f);
        }
      }
    }
  }

  const out = {
    _ts: tsHeader(),
    ok: true,
    query,
    root: resolved,
    match_count: raw.length,
    returned: scored.length,
    matches: scored,
    imports,
    imported_by,
  };
  const outputBytes = Buffer.byteLength(JSON.stringify(out));
  new Ledger().record('agent_search', {
    inputBytes: Buffer.byteLength(query),
    outputBytes,
    avoidedBytes: files.reduce((acc, f) => acc + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0),
    note: `query '${query.slice(0, 40)}'`,
  });
  return out;
}

function extractImports(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 80).join('\n');
    const out = [];
    for (const line of head.split('\n')) {
      const m = line.match(/^\s*(?:import\s+(?:[^{]*from\s+)?['"]([^'"]+)['"]|from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)|import\s+['"]([^'"]+)['"])/);
      const mm = line.match(/^\s*(?:import|from|require\(|use\s+[\w:]+::|using\s+)/);
      if (m) out.push(m[1] || m[2] || m[3] || m[4]);
      else if (mm) out.push(line.trim());
    }
    return [...new Set(out)].slice(0, 12);
  } catch { return []; }
}