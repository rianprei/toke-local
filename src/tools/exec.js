'use strict';

import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { tsHeader } from '../util.js';
import { Ledger } from '../ledger.js';

const FAILURE_RE = /(FAIL|FAILED|failing|failures|Error|Exception|AssertionError|Traceback|panic|✗|E\d{3,}|WARN(?:ING)?\s*[:.)])/i;
const PASS_RE = /(PASS|passed|\bok\b|✓|All tests? passed|\d+ passed)/i;

export async function agentExec({ command, args = [], cwd, timeoutMs = 30000, waitMs = 0, until, digest = true, keepFull = true }) {
  const led = new Ledger();
  if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
  const { stdout, stderr, code, timedOut, durationMs, signal } = await run(command, args, { cwd, timeoutMs });

  let full = stdout + stderr;
  let untilMatched = null;
  let untilNote = null;
  if (until && full.trim()) {
    const re = safeRe(until);
    untilMatched = re.test(full);
    if (!untilMatched) {
      untilNote = `[until '${until}' not matched — keeping output]`;
      full += `\n${untilNote}`;
    }
  }

  let receiptId = null;
  if (keepFull && full.trim()) {
    receiptId = crypto.createHash('sha1').update(full + String(Date.now())).digest('hex').slice(0, 16);
    led.writeLog(receiptId, full);
  }

  let digestText = null;
  if (digest !== false && full.trim()) digestText = digestLog(full, code, signal, untilNote, `${command} ${args.join(' ')}`);

  const output = digestText || full;
  const inputBytes = Buffer.byteLength(`${command} ${args.join(' ')}`);
  const outputBytes = Buffer.byteLength(output);
  const fullBytes = Buffer.byteLength(full);
  led.record('agent_exec', {
    inputBytes, outputBytes,
    avoidedBytes: fullBytes > 0 ? fullBytes - outputBytes : 0,
    note: `${command} ${args.join(' ')}`,
  });

  return {
    _ts: tsHeader(),
    ok: code === 0,
    exit_code: code,
    signal: signal || null,
    timed_out: timedOut || false,
    duration_ms: durationMs,
    called_with: { command, args, wait_ms: waitMs },
    input_bytes: inputBytes,
    output_bytes: outputBytes,
    full_bytes: fullBytes,
    omitted_bytes: Math.max(fullBytes - outputBytes, 0),
    receipt: receiptId,
    until_matched: untilMatched,
    digest_lines: digestText ? digestText.split('\n').length : null,
    text: output,
    hint: code === 0 ? 'exit 0' : `command exited ${code}${timedOut ? ' (timed out)' : ''}`,
  };
}

function run(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '', stderr = '';
    let done = false;
    let child;
    const finish = (extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: -1, durationMs: Date.now() - start, ...extra });
    };
    const timer = setTimeout(() => {
      if (child) child.kill('SIGKILL');
      finish({ timedOut: true });
    }, timeoutMs || 30000);

    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: String(err.message), code: -1, durationMs: 0, timedOut: false, signal: null });
      return;
    }
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    child.on('error', () => finish({ code: -1, signal: null }));
    child.on('close', (code, signal) => {
      finish({ code: code === null ? 1 : code, signal });
    });
  });
}

export async function agentGit({ cwd = process.cwd() }) {
  const led = new Ledger();
  const git = (args, noThrow = true) => new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout) => resolve(err && noThrow ? '' : (stdout || '').trim()));
  });

  const [branch, statusRaw, logRaw, diffRaw, stashRaw, upstream, remoteRaw] = await Promise.all([
    git(['branch', '--show-current']),
    git(['status', '--porcelain']),
    git(['log', '--oneline', '-n', '5']),
    git(['diff', '--stat', 'HEAD~1']),
    git(['stash', 'list']),
    git(['rev-parse', '--abbrev-ref', '@{upstream}']),
    git(['remote', '-v']),
  ]);

  const dirtyLines = statusRaw.split('\n').filter(Boolean);
  const isDirty = dirtyLines.length > 0;
  const filesChanged = sumStat(diffRaw, /(\d+) files? changed/g);
  const insertions = sumStat(diffRaw, /(\d+) insertions?/g);
  const deletions = sumStat(diffRaw, /(\d+) deletions?/g);
  const aheadBehind = await git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], true);
  const [ahead, behind] = aheadBehind ? aheadBehind.split(/\s+/).map(Number) : [0, 0];
  const mergeInProgress = (await git(['rev-parse', '--verify', 'MERGE_HEAD'])).length > 0;
  const remoteNames = remoteRaw.split('\n').filter(Boolean).map(l => l.split(/\s+/)[0]).filter((v, i, a) => a.indexOf(v) === i);

  const outputBytes = Buffer.byteLength(JSON.stringify({ branch, dirtyLines, logRaw, diffRaw }));
  led.record('agent_git', { inputBytes: 0, outputBytes, avoidedBytes: outputBytes * 4 });

  return {
    _ts: tsHeader(),
    ok: true,
    branch: branch || null,
    upstream: upstream || null,
    remote: remoteNames[0] || null,
    ahead, behind,
    dirty: isDirty,
    files_changed: dirtyLines.length,
    modified: dirtyLines.slice(0, 30),
    diffstat: { files: filesChanged, insertions, deletions },
    recent_commits: logRaw.split('\n').filter(Boolean),
    stash: stashRaw.split('\n').filter(Boolean),
    merge: mergeInProgress ? 'merge in progress' : null,
  };
}

function sumStat(text, re) {
  let n = 0;
  for (const m of text.matchAll(re)) n += Number(m[1]);
  return n;
}

function digestLog(full, code, signal, note, cmdline) {
  const lines = full.split('\n');
  const keep = [];
  const push = (l, w = 200) => keep.push(l.length > w ? l.slice(0, w) + '…' : l);

  push(`cmd: ${cmdline || ''}`);
  push(`exit: ${code}${signal ? ` (${signal})` : ''}`);
  if (note) push(note);

  const failures = [];
  let consumedUntil = -1;
  for (let i = 0; i < lines.length; i++) {
    if (i <= consumedUntil) continue;
    const line = lines[i];
    if (FAILURE_RE.test(line)) {
      push(line);
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const c = lines[j];
        if (/^\s+/.test(c) || /^\s+at\s/.test(c)) { push(c); consumedUntil = j; }
        else break;
      }
      failures.push(line);
    } else if (/^(\d+)\s+(passed|failed)/.test(line) || /passed|failed/.test(line) && /^\d/.test(line)) {
      push(line);
    }
  }
  if (failures.length === 0) push('(no failures matched by pattern)');

  const omitted = Math.max(lines.length - keep.length, 0);
  push(`[digest] ${lines.length} lines → ${keep.length} (${omitted} omitted)`);
  return keep.join('\n');
}

function safeRe(s) {
  try { return new RegExp(s); } catch { return /^$/; }
}