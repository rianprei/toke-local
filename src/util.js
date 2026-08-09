'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HEADER = tsHeader;

export function tsHeader() {
  return `[now: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} UTC]`;
}

export function estTokens(bytes) {
  return Math.ceil(bytes / 4);
}

export function toMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

export function toKB(bytes) {
  return (bytes / 1024).toFixed(1);
}

export function normalizeWS(s) {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

export function normalizeQuotes(s) {
  return normalizeWS(s).replace(/'/g, '"');
}

export function fuzzyIndex(haystackLines, needleLines, { quoteInsensitive = true } = {}) {
  const hay = haystackLines.map(l => normalizeQuotes(l));
  const needle = needleLines.map(l => normalizeQuotes(l));
  const hl = hay.length, nl = needle.length;
  for (let i = 0; i + nl <= hl; i++) {
    let score = 0;
    for (let j = 0; j < nl; j++) {
      if (hay[i + j] === needle[j]) score++;
    }
    if (score >= nl) return { index: i, score: 1 };
  }
  return { index: -1, score: 0 };
}

export function countOccurrences(lines, needleLines, quoteInsensitive = true) {
  const hay = lines.map(l => normalizeQuotes(l));
  const needle = needleLines.map(l => normalizeQuotes(l));
  let count = 0;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) count++;
  }
  return count;
}

export function classifyExt(file) {
  const ext = path.extname(file).toLowerCase();
  const codeLangs = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.sql', '.json', '.yaml', '.yml', '.toml', '.ini', '.html', '.css', '.scss', '.less', '.vue', '.svelte']);
  if (codeLangs.has(ext)) return 'code';
  return 'text';
}

export function findFiles(dir, { ignoreDirs = ['node_modules', '.git', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__'] } = {}) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!ignoreDirs.includes(e.name)) walk(p);
      } else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}