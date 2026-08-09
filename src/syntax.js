'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const nodeRequire = createRequire(import.meta.url);

function checkWithNode(content, ext) {
  const tmp = path.join(os.tmpdir(), `toke-syntax-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`);
  try {
    fs.writeFileSync(tmp, content);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    return { ok: true, tool: 'node --check' };
  } catch (err) {
    const raw = (err.stderr && err.stderr.toString()) || (err.stdout && err.stdout.toString()) || (err.message || 'syntax error');
    const lines = String(raw).split('\n').map(l => l.trim()).filter(Boolean);
    const cleaned = lines.filter(l => !/^file:/i.test(l) && !/\bnode --check\b/.test(l)).slice(0, 3);
    return { ok: false, error: cleaned.join('\n') || 'syntax error' };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

const TS_PATHS = [
  process.env.TOKE_TS_LIB,
  '/data/data/com.termux/files/usr/lib/node_modules/typescript/lib/typescript.js',
];

function checkTS(content, ext) {
  for (const p of TS_PATHS) {
    if (!p || !fs.existsSync(p)) continue;
    try {
      const ts = nodeRequire(p);
      const kind = ext === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sf = ts.createSourceFile('_toke_check.tsx', content, ts.ScriptTarget.Latest, true, kind);
      const diags = sf.parseDiagnostics || [];
      if (diags.length === 0) return { ok: true, tool: 'typescript' };
      const first = diags[0];
      const pos = first.start == null ? 0 : first.start;
      const line = content.slice(0, pos).split('\n').length;
      return { ok: false, error: `TS${first.code}: ${first.messageText} (line ${line})` };
    } catch { continue; }
  }
  return null;
}

function checkPython(content) {
  const tmp = path.join(os.tmpdir(), `toke-syntax-${process.pid}-${Math.random().toString(36).slice(2)}.py`);
  try {
    fs.writeFileSync(tmp, content);
    execFileSync('python3', ['-m', 'py_compile', tmp], { stdio: 'pipe' });
    return { ok: true, tool: 'py_compile' };
  } catch (err) {
    return { ok: false, error: String((err.stderr && err.stderr.toString()) || err.message || 'syntax').split('\n').filter(l => l.trim()).slice(0, 3).join('\n') };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function checkYaml(content) {
  const tmp = path.join(os.tmpdir(), `toke-syntax-${process.pid}-${Math.random().toString(36).slice(2)}.yaml`);
  try {
    fs.writeFileSync(tmp, content);
    execFileSync('python3', ['-c', 'import sys,yaml; yaml.safe_load(open(sys.argv[1]))', tmp], { stdio: 'pipe' });
    return { ok: true, tool: 'pyyaml' };
  } catch (err) {
    return { ok: false, error: String((err.stderr && err.stderr.toString()) || err.message || 'yaml error').split('\n').filter(l => l.trim()).slice(0, 3).join('\n') };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

const SYNTAX_CHECKERS = {
  '.json': (content) => {
    try { JSON.parse(content); return { ok: true, tool: 'JSON.parse' }; }
    catch (err) { return { ok: false, error: `JSON.parse: ${err.message.split('\n')[0]}` }; }
  },
  '.js': (content) => checkWithNode(content, '.js'),
  '.mjs': (content) => checkWithNode(content, '.mjs'),
  '.cjs': (content) => checkWithNode(content, '.cjs'),
  '.ts': (content) => {
    const ts = checkTS(content, '.ts');
    if (ts) return ts;
    const node = checkWithNode(content, '.ts');
    if (!node.ok) return node;
    return { ok: true, tool: 'node --check (typescript lib not available)' };
  },
  '.tsx': (content) => {
    const ts = checkTS(content, '.tsx');
    if (ts) return ts;
    const node = checkWithNode(content, '.tsx');
    if (!node.ok) return node;
    return { ok: true, tool: 'node --check (typescript lib not available)' };
  },
  '.py': (content) => checkPython(content),
  '.yaml': (content) => checkYaml(content),
  '.yml': (content) => checkYaml(content),
};

export function validateSyntax(file, content) {
  const ext = path.extname(file).toLowerCase();
  const checker = SYNTAX_CHECKERS[ext];
  if (!checker) return { ok: true, skipped: `no checker for .${ext}`, lang: ext };
  return { ...checker(content), lang: ext };
}