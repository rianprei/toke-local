'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { classifyExt, tsHeader } from '../util.js';
import { Ledger } from '../ledger.js';

const MAX_STRUCTURE_BODY = 10;

export function agentRead({ file, mode = 'structure' }) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return { ok: false, error: 'file_not_found', message: `no such file: ${abs}` };
  const content = fs.readFileSync(abs, 'utf8');
  const totalBytes = Buffer.byteLength(content);
  const lines = content.split('\n');
  const totalLines = lines.length;

  const klass = classifyExt(abs);

  let rendered;
  if (mode === 'full') rendered = content;
  else if (klass === 'text') rendered = content; // no structure to keep
  else rendered = structural(lines, abs);

  const output = rendered;
  const outBytes = Buffer.byteLength(output);
  new Ledger().record('agent_read', {
    inputBytes: 0,
    outputBytes: outBytes,
    avoidedBytes: Math.max(totalBytes - outBytes, 0),
    note: abs,
  });
  return {
    _ts: tsHeader(),
    ok: true,
    file: abs,
    total_lines: totalLines,
    mode,
    total_bytes: totalBytes,
    output_bytes: outBytes,
    reduced: totalBytes > 0 ? Math.round((1 - outBytes / totalBytes) * 100) : 0,
    snippet: output,
  };
}

function structural(lines, file) {
  // naive structural compaction: keep import/export/type/interface/class
  // first lines, collapse bodies of large function-like braces
  const out = [];
  let i = 0;
  const n = lines.length;
  const isPy = /\.py$/.test(file) || /\.go$/.test(file) || /\.rb$/.test(file);
  while (i < n) {
    const raw = lines[i];
    const t = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    const decl = /^(import|export|type|interface|class|enum|const|let|var|function|async\s+function|#|def|func|package)/;
    if (decl.test(t) && !isFnHeader(t) && !(isPy && /^(def|class)\b/.test(t))) {
      out.push(lines[i]);
      i++;
      continue;
    }
    if (isFnHeader(t) || (isPy && /^(def|async\s+def|class)\b/.test(t))) {
      out.push(lines[i]);
      if (isPy) {
        let j = i + 1;
        let bodyEnd = -1;
        while (j < n) {
          const r2 = lines[j];
          const t2 = r2.trim();
          if (t2 && !t2.startsWith('#') && r2.length - r2.trimStart().length <= indent) { bodyEnd = j; break; }
          j++;
        }
        if (bodyEnd === -1) bodyEnd = n;
        const bodyLen = bodyEnd - i - 1;
        if (bodyLen <= MAX_STRUCTURE_BODY) {
          for (let k = i + 1; k < bodyEnd; k++) out.push(lines[k]);
          if (bodyEnd < n) out.push(lines[bodyEnd]);
        } else {
          out.push(`    /* [body omitted: ${bodyLen} lines] */`);
          if (bodyEnd < n) out.push(lines[bodyEnd]);
        }
        i = Math.min(bodyEnd + 1, n);
        continue;
      }
      let depth = countBrace(lines[i], 0);
      let j = i + 1;
      let bodyEnd = -1;
      while (j < n) {
        depth += countBrace(lines[j], 0);
        if (depth <= 0) { bodyEnd = j; break; }
        j++;
      }
      if (bodyEnd === -1) { out.push(...lines.slice(i + 1)); break; }
      const bodyLen = bodyEnd - i - 1;
      if (bodyLen > 0) {
        if (bodyLen <= MAX_STRUCTURE_BODY) {
          for (let k = i + 1; k <= bodyEnd; k++) out.push(lines[k]);
        } else {
          out.push(`    /* [body omitted: ${bodyLen} lines] */`);
          out.push(lines[bodyEnd]);
        }
        i = bodyEnd + 1;
        continue;
      }
      i++;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

function isFnHeader(t) {
  return /^[a-zA-Z_$][\w$]*\s*\([^)]*\)\s*(?::[^{]+)?\{?\s*$/.test(t) || /^constructor\s*\(/.test(t) || /^(export\s+)?(default\s+)?(async\s+)?function\b/.test(t) || /^[a-zA-Z_$][\w$]*\s*=\s*(async\s*)?\(.*\)\s*=>/.test(t) || /^(public|private|protected)\s+[a-zA-Z_$][\w$]*\s*\(/.test(t);
}

function countBrace(line, init) {
  let d = init;
  for (const ch of line) { if (ch === '{') d++; else if (ch === '}') { d--; if (d <= 0) return d; } }
  return d;
}