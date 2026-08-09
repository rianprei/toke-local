'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { normalizeQuotes, tsHeader } from '../util.js';
import { Ledger } from '../ledger.js';
import { validateSyntax } from '../syntax.js';
import { readSnapshot, applySnapshotPatch, SnapError } from '../../../snapedit/src/snapshot.js';

export function agentEdit({ edits, validate = true, cwd = process.cwd() }) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: 'bad_arg', message: 'edits must be a non-empty array of {path, old_text|from|to, new_text}' };
  }
  const results = [];
  for (const e of edits) {
    results.push(applyOne(e, { validate, cwd }));
  }
  const okCount = results.filter(r => r.ok === true).length;
  const outputBytes = Buffer.byteLength(JSON.stringify(results));
  new Ledger().record('agent_edit', {
    inputBytes: Buffer.byteLength(JSON.stringify(edits)),
    outputBytes,
    avoidedBytes: okCount * 6000, // failed edit + re-anchor read chain, estimated
    note: `${results.length} file(s), ${okCount} ok`,
  });
  return { _ts: tsHeader(), ok: okCount === results.length, results };
}

function applyOne(e, { validate, cwd }) {
  const root = path.resolve(cwd);
  const abs = path.resolve(root, e.path);
  const realRoot = safeRealpath(root);
  const realAbs = safeRealpath(abs);
  if (abs !== root && !abs.startsWith(root + path.sep) || realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
    return { ok: false, error: 'out_of_scope', message: `path escapes working directory: ${abs}` };
  }
  if (!fs.existsSync(abs)) return { ok: false, error: 'file_not_found', message: `no such file: ${abs}` };

  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split('\n');

  let hunk;
  if (e.old_text !== undefined) {
    const found = fuzzyFind(lines, e.old_text);
    if (!found) return { ok: false, error: 'not_found', message: 'old_text not found (fuzzy match failed)' };
    if (found.count > 1) {
      return {
        ok: false, error: 'ambiguous',
        message: `old_text matches ${found.count} locations; use exact from/to or widen the hunk`,
        detail: { occurrences: found.count, first_line: found.index + 1 },
      };
    }
    hunk = { from: found.index + 1, to: found.index + found.lines };
  } else {
    const from = Number(e.from);
    const to = Number(e.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      return { ok: false, error: 'bad_range', message: `invalid range from=${e.from} to=${e.to}` };
    }
    hunk = { from, to };
  }

  if (typeof e.new_text !== 'string') return { ok: false, error: 'bad_arg', message: 'missing string new_text' };
  if (hunk.from > lines.length) return { ok: false, error: 'bad_range', message: `from=${hunk.from} beyond file (${lines.length} lines)` };

  if (validate) {
    const head = lines.slice(0, hunk.from - 1);
    const tail = lines.slice(hunk.to);
    const preview = head.concat(newContentLines(e.new_text)).concat(tail).join('\n');
    const v = validateSyntax(abs, preview);
    if (!v.ok) return { ok: false, error: 'invalid_syntax', message: v.error, detail: { lang: v.lang } };
  }

  let res;
  try {
    const snap = readSnapshot(abs, {}, undefined);
    res = applySnapshotPatch(abs, snap.blob_id, hunk.from, hunk.to, e.new_text);
    if (!res.ok) {
      return {
        ok: false,
        error: res.mode === 'conflict' ? 'conflict' : res.mode === 'ambiguous' ? 'ambiguous' : 'apply_failed',
        message: res.hint || JSON.stringify(res),
      };
    }
    return {
      ok: true, path: abs, from: hunk.from, to: hunk.to,
      mode: res.mode, written_lines: res.written_lines, blob_id: res.new_blob_id,
    };
  } catch (err) {
    if (err instanceof SnapError) return { ok: false, error: err.kind, message: err.message, detail: err.detail };
    return { ok: false, error: 'internal', message: err.message };
  }
}

function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function newContentLines(t) {
  const s = t.replace(/\n$/, '');
  return s === '' ? [''] : s.split('\n');
}

function fuzzyFind(lines, oldText) {
  const needle = oldText.replace(/\n$/, '').split('\n');
  const normNeedle = needle.map(l => normalizeQuotes(l));
  const normHay = lines.map(l => normalizeQuotes(l));
  const hits = [];
  for (let i = 0; i + normNeedle.length <= normHay.length; i++) {
    let match = true;
    for (let j = 0; j < normNeedle.length; j++) {
      if (normHay[i + j] !== normNeedle[j]) { match = false; break; }
    }
    if (match) hits.push(i);
  }
  if (hits.length > 0) return { count: hits.length, index: hits[0], lines: normNeedle.length };

  const compact = (s) => s.replace(/\s+/g, '').replace(/['"]/g, '');
  const cNeedle = needle.map(compact);
  const cHay = lines.map(compact);
  const chits = [];
  for (let i = 0; i + cNeedle.length <= cHay.length; i++) {
    let match = true;
    for (let j = 0; j < cNeedle.length; j++) {
      if (cHay[i + j] !== cNeedle[j]) { match = false; break; }
    }
    if (match) chits.push(i);
  }
  if (chits.length === 1) return { count: 1, index: chits[0], lines: cNeedle.length };
  if (chits.length > 1) return { count: chits.length, index: chits[0], lines: cNeedle.length, compact: true };
  return null;
}