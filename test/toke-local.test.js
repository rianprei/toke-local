'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'toke-local');

import { agentSearch } from '../src/tools/search.js';
import { agentRead } from '../src/tools/read.js';
import { agentEdit } from '../src/tools/edit.js';
import { agentExec, agentGit } from '../src/tools/exec.js';
import { agentSavings } from '../src/tools/savings.js';

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toke-test-'));
  fs.writeFileSync(path.join(dir, 'invoice.ts'), [
    "import { calc } from './helpers';",
    "import { Invoice } from './types';",
    '',
    'export function renderInvoice(invoice: Invoice): string {',
    '  const lines: string[] = [];',
    '  for (const item of invoice.items) {',
    '    lines.push(`${item.name}: ${item.price}`);',
    '  }',
    '  const total = calc(invoice.items);',
    '  const label = total > 100 ? "big" : "small";',
    '  return `${label}: ${lines.join("\\n")}`;',
    '}',
    '',
    'export function calculateTax(amount: number, rate: number): number {',
    '  return amount * rate;',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'data.json'), '{"key": "value", "n": 1}\n');
  fs.writeFileSync(path.join(dir, 'script.py'), 'def main():\n    return 1\n');
  fs.writeFileSync(path.join(dir, 'big.js'), [
    "import { dep } from './dep';",
    'export function huge(input) {',
    '  const steps = [];',
    '  for (let i = 0; i < 100; i++) {',
    '    steps.push(i * 2);',
    '    const deeper = {',
    '      nested: () => {',
    '        return i;',
    '      },',
    '    };',
    '    if (steps.length % 3 === 0) { steps.pop(); }',
    '  }',
    '  return steps;',
    '}',
    '',
  ].join('\n'));
  return dir;
}

test('agent_search: ranked matches + imports', async () => {
  const dir = makeWorkspace();
  const r = await agentSearch({ query: 'renderInvoice', root: dir });
  assert.equal(r.ok, true);
  assert.ok(r.matches.length >= 1, 'found renderInvoice');
  const file = r.matches[0].file;
  assert.ok(file.includes('invoice.ts'));
  const imps = (r.imports && r.imports[file]) || [];
  assert.equal(imps.some(l => l.includes('./helpers')), true, `helpers import: ${imps.join('|')}`);
  assert.equal(imps.some(l => l.includes('./types')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_read: structure stubs long bodies, keeps imports', () => {
  const dir = makeWorkspace();
  const r = agentRead({ file: path.join(dir, 'big.js'), mode: 'structure' });
  assert.equal(r.ok, true);
  assert.match(r.snippet, /import \{ dep \}/);
  assert.match(r.snippet, /export function huge/);
  assert.match(r.snippet, /body omitted/);
  assert.ok(r.output_bytes <= r.total_bytes * 0.5, `expected reduction, got ${r.output_bytes}/${r.total_bytes}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_edit: fuzzy whitespace match + valid write', () => {
  const dir = makeWorkspace();
  const r = agentEdit({
    cwd: dir,
    edits: [{
      path: 'invoice.ts',
      old_text: 'export function calculateTax(amount:number,rate:number):number {\n  return amount * rate;\n}',
      new_text: 'export function calculateTax(amount: number, rate: number): number {\n  return Math.round(amount * rate * 100) / 100;\n}',
    }],
  });
  assert.equal(r.ok, true);
  const r2 = r.results[0];
  assert.equal(r2.ok, true);
  assert.equal(r2.mode, 'fast');
  const out = fs.readFileSync(path.join(dir, 'invoice.ts'), 'utf8');
  assert.match(out, /Math\.round\(amount \* rate \* 100\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_edit: invalid syntax rejected, file untouched', () => {
  const dir = makeWorkspace();
  const r = agentEdit({
    cwd: dir,
    edits: [{ path: 'invoice.ts', old_text: 'return amount * rate;', new_text: 'return (;' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].error, 'invalid_syntax');
  const out = fs.readFileSync(path.join(dir, 'invoice.ts'), 'utf8');
  assert.match(out, /return amount \* rate;/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_edit: ambiguous match refused', () => {
  const dir = makeWorkspace();
  fs.writeFileSync(path.join(dir, 'd.ts'), [
    'function a() { return 1; }',
    'function a() { return 1; }',
  ].join('\n'));
  const r = agentEdit({
    cwd: dir,
    edits: [{ path: 'd.ts', old_text: 'function a() { return 1; }', new_text: 'function b() { return 2; }' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].error, 'ambiguous');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_exec: digest preserves failures, receipt saves full', async () => {
  const dir = makeWorkspace();
  const r = await agentExec({
    command: 'sh',
    args: ['-c', 'printf "PASS ok\\nFAIL auth\\nAssertionError: expected 1 to equal 2\\n  at auth.test.ts:83\\n"; seq 1 300'],
    cwd: dir,
  });
  assert.equal(r.ok, true);
  assert.equal(r.exit_code, 0);
  assert.match(r.text, /FAIL auth/);
  assert.match(r.text, /AssertionError/);
  assert.match(r.text, /\[digest\]/);
  assert.ok(r.receipt);
  const s = agentSavings({ log_id: r.receipt, log_limit: 10000 });
  assert.equal(s.ok, true);
  assert.match(s.text, /PASS ok/);
  assert.match(s.text, /^300$/m);
  const sz = s.total_lines ?? 0;
  assert.ok(sz > 300, `full log should exceed digest: ${sz}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_git: repo state', async () => {
  const dir = makeWorkspace();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  const r = await agentGit({ cwd: dir });
  assert.equal(r.ok, true);
  assert.equal(r.branch, 'main');
  assert.equal(r.dirty, false);
  fs.writeFileSync(path.join(dir, 'invoice.ts'), 'export const x = 2;\n');
  const r2 = await agentGit({ cwd: dir });
  assert.equal(r2.dirty, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_exec: until flag reflected, note kept on no-match', async () => {
  const dir = makeWorkspace();
  const hit = await agentExec({ command: 'sh', args: ['-c', 'echo READY'], cwd: dir, digest: false });
  const miss = await agentExec({ command: 'sh', args: ['-c', 'echo boot'], cwd: dir, until: 'READY' });
  assert.equal(miss.until_matched, false);
  assert.ok(miss.text.includes("not matched"));
  const hit2 = await agentExec({ command: 'sh', args: ['-c', 'echo READY'], cwd: dir, until: 'READY' });
  assert.equal(hit2.until_matched, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_edit: quote-insensitive fuzzy (single vs double quotes)', () => {
  const dir = makeWorkspace();
  fs.writeFileSync(path.join(dir, 'q.ts'), "const a = {\n  msg: 'hello',\n  n: 1,\n};\n");
  const r = agentEdit({
    cwd: dir,
    edits: [{
      path: 'q.ts',
      old_text: 'const a = {\n  msg: "hello",\n  n: 1,\n};',
      new_text: 'const a = {\n  msg: "hi",\n  n: 2,\n};',
    }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].ok, true);
  const out = fs.readFileSync(path.join(dir, 'q.ts'), 'utf8');
  assert.match(out, /msg: "hi"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_exec: wait_ms delays execution', async () => {
  const dir = makeWorkspace();
  const t0 = Date.now();
  await agentExec({ command: 'true', cwd: dir, waitMs: 400 });
  const t1 = Date.now();
  assert.ok(t1 - t0 >= 350, `expected >=350ms, got ${t1 - t0}`);
  const r = await agentExec({ command: 'sh', args: ['-c', 'echo x'], cwd: dir, waitMs: 50 });
  assert.equal(r.called_with.wait_ms, 50);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_git: diffstat lists files count', async () => {
  const dir = makeWorkspace();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'one'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'note.txt'), 'changed\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'two'], { cwd: dir });
  const r = await agentGit({ cwd: dir });
  assert.equal(r.ok, true);
  assert.equal(typeof r.diffstat.files, 'number');
  assert.ok(r.diffstat.files >= 1, `expected >=1 file in diffstat, got ${r.diffstat.files}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_edit: yaml syntax validated before write', () => {
  const dir = makeWorkspace();
  fs.writeFileSync(path.join(dir, 'c.yml'), 'name: app\nport: 8080\n');
  const good = agentEdit({
    cwd: dir,
    edits: [{ path: 'c.yml', old_text: 'port: 8080', new_text: 'port: 9090' }],
  });
  assert.equal(good.ok, true);
  const bad = agentEdit({
    cwd: dir,
    edits: [{ path: 'c.yml', old_text: 'port: 9090', new_text: 'port: [unclosed' }],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.results[0].error, 'invalid_syntax');
  const out = fs.readFileSync(path.join(dir, 'c.yml'), 'utf8');
  assert.match(out, /9090/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_savings: ledger totals and reset', () => {
  const dir = makeWorkspace();
  return agentExec({ command: 'true', cwd: dir, keepFull: false }).then(async () => {
    const s = await agentSavings({});
    assert.equal(s.ok, true);
    assert.ok(s.totals.calls >= 1);
    const r2 = agentSavings({ reset: true });
    assert.equal(r2.totals.calls, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('agent_search: context_lines populated from rg -C', async () => {
  const dir = makeWorkspace();
  const r = await agentSearch({ query: 'renderInvoice', root: dir, context_lines: 2 });
  assert.equal(r.ok, true);
  const m = r.matches.find(x => x.file.includes('invoice.ts'));
  assert.ok(m, 'invoice match present');
  assert.ok(Array.isArray(m.context_lines) && m.context_lines.length > 0, `expected context lines, got ${JSON.stringify(m.context_lines)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_read: no duplicated header lines', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "toke-test-"));
  fs.writeFileSync(path.join(dir, 'cls.ts'), 'class A {\n  private x: number;\n  constructor(x: number) { this.x = x; }\n}\n');
  const r = agentRead({ file: path.join(dir, 'cls.ts'), mode: 'structure' });
  assert.equal(r.ok, true);
  assert.equal((r.snippet.match(/private x: number;/g) || []).length, 1, 'x declared once');
  assert.equal((r.snippet.match(/constructor\(x: number\)/g) || []).length, 1, 'ctor once');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_exec: keeps ALL failure lines beyond 20', async () => {
  const dir = makeWorkspace();
  const fails = Array.from({ length: 30 }, (_, i) => `FAIL test_${i}: boom ${i}`).join('\n');
  const r = await agentExec({ command: 'sh', args: ['-c', `printf '%s' "${fails}"`], cwd: dir });
  for (let i = 0; i < 30; i++) assert.match(r.text, new RegExp(`FAIL test_${i}: boom`), `fail line ${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_edit: path traversal outside cwd is rejected', () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "toke-test-"));
  const victim = path.join(outside, 'victim.ts');
  fs.writeFileSync(victim, 'let x = 1;\n');
  const dir = makeWorkspace();
  const evil = path.relative(dir, victim).replace(/^..\//, '../');
  const r = agentEdit({ cwd: dir, edits: [{ path: evil, old_text: 'let x = 1;', new_text: 'let x = 999;' }] });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].error, 'out_of_scope');
  assert.match(fs.readFileSync(victim, 'utf8'), /let x = 1;/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('agent_search: leading context lines preserved', async () => {
  const dir = makeWorkspace();
  const r = await agentSearch({ query: 'renderInvoice', root: dir, context_lines: 2 });
  assert.equal(r.ok, true);
  const m = r.matches.find(x => x.file.includes('invoice.ts'));
  assert.ok(m && m.context_lines.length > 0);
  assert.ok(m.context_lines.some(l => l.includes("import { Invoice }")), `expected leading context, got ${JSON.stringify(m.context_lines)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_edit: symlink escape is blocked', () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'toke-test-'));
  const victim = path.join(outside, 'secret.ts');
  fs.writeFileSync(victim, 'let secret = 1;\n');
  const dir = makeWorkspace();
  fs.symlinkSync(victim, path.join(dir, 'link.ts'));
  const r = agentEdit({ cwd: dir, edits: [{ path: 'link.ts', old_text: 'let secret = 1;', new_text: 'let secret = 999;' }] });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.results[0].error, 'out_of_scope');
  assert.match(fs.readFileSync(victim, 'utf8'), /let secret = 1;/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('agent_read: private field does not swallow method signature', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'toke-test-'));
  fs.writeFileSync(path.join(dir, 'cls2.ts'), 'class A {\n  private x: number;\n  method() {\n    return this.x;\n  }\n}\n');
  const r = agentRead({ file: path.join(dir, 'cls2.ts'), mode: 'structure' });
  assert.equal(r.ok, true);
  assert.match(r.snippet, /private x: number;/);
  assert.match(r.snippet, /method\(\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_exec: CLI maps snake_case timeout_ms + wait_ms', async () => {
  const dir = makeWorkspace();
  const out = execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'exec', JSON.stringify({ command: 'sleep', args: ['1'], cwd: dir, timeout_ms: 200, keep_full: false })], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.timed_out, true, JSON.stringify(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_search: imported_by lists files importing a match', async () => {
  const dir = makeWorkspace();
  fs.writeFileSync(path.join(dir, 'consumer.ts'), "import { renderInvoice } from './invoice';\nconsole.log(renderInvoice);\n");
  const r = await agentSearch({ query: 'renderInvoice', root: dir });
  assert.equal(r.ok, true);
  const m = r.matches.find(x => x.file.includes('invoice.ts'));
  assert.ok(m, 'invoice match');
  const ib = r.imported_by && r.imported_by[m.file];
  assert.ok(Array.isArray(ib) && ib.some(f => f.includes('consumer.ts')), `imported_by for invoice: ${JSON.stringify(ib)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_git: remote url surfaced when configured', async () => {
  const dir = makeWorkspace();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  const r = await agentGit({ cwd: dir });
  assert.equal(r.ok, true);
  assert.equal(r.remote, null);
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/repo.git'], { cwd: dir });
  const r2 = await agentGit({ cwd: dir });
  assert.equal(r2.remote, 'origin');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent_exec: digest carries cmd line', async () => {
  const dir = makeWorkspace();
  const r = await agentExec({ command: 'printf', args: ['READY'], cwd: dir });
  assert.match(r.text, /cmd: printf READY/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP server: initialize + tools/call round trip', () => {
  const dir = makeWorkspace();
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_read', arguments: { file: path.join(dir, 'invoice.ts') } } }),
    '',
  ].join('\n');
  const res = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'mcp'], { input, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result.serverInfo.name, 'toke-local');
  const call = lines[1];
  assert.equal(call.id, 2);
  const text = JSON.parse(call.result.content[0].text);
  assert.equal(text.ok, true);
  assert.ok(text.snippet.includes('renderInvoice'));
  fs.rmSync(dir, { recursive: true, force: true });
});