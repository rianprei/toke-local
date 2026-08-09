'use strict';

import readline from 'node:readline';
import { agentSearch } from './tools/search.js';
import { agentRead } from './tools/read.js';
import { agentEdit } from './tools/edit.js';
import { agentExec, agentGit } from './tools/exec.js';
import { agentSavings } from './tools/savings.js';
import { tsHeader } from './util.js';

const VERSION = '1.0.0';

const TOOLS = [
  {
    name: 'agent_search',
    description: `ONE-CALL ranked code search replacing glob→grep→read→import-analysis.
Use for symbol/string discovery instead of chaining Glob/Grep/Read.
Returns ranked matches (+context) and the import graph of matched files.
Set root to a directory; query is a literal substring (supports regex via rg).`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'text or regex to search' },
        root: { type: 'string', description: 'directory to search (default cwd)' },
        max_results: { type: 'integer', description: 'cap on returned matches (default 12)' },
        context_lines: { type: 'integer', description: 'context lines per match (default 1)' },
        file_pattern: { type: 'string', description: 'optional glob, e.g. "*.ts"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'agent_read',
    description: 'Structure-aware read. Keeps imports/types/interfaces/signatures and stubs long function bodies — avoids full-file dumps. Use instead of a plain Read for code files.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'file to read' },
        mode: { type: 'string', enum: ['structure', 'full'], description: 'structure (default) or full' },
      },
      required: ['file'],
    },
  },
  {
    name: 'agent_edit',
    description: 'Batch multi-file edits: fuzzy whitespace/quote-tolerant matching, syntax validation BEFORE write, apply via snapedit (immutable blob + 3-way merge + atomic write + ambiguity refusal). Use instead of str_replace/edit_file when you have old_text.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: 'edits: [{path, old_text, new_text} | {path, from, to, new_text}]',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              old_text: { type: 'string', description: 'fuzzy match anchor (whitespace/quote tolerant)' },
              from: { type: 'integer', description: '1-based inclusive start line (alt to old_text)' },
              to: { type: 'integer', description: '1-based inclusive end line (alt to old_text)' },
              new_text: { type: 'string' },
            },
            required: ['path', 'new_text'],
          },
        },
        validate: { type: 'boolean', description: 'run syntax validator before write (default true)' },
        cwd: { type: 'string', description: 'working dir for relative paths (default cwd)' },
      },
      required: ['edits'],
    },
  },
  {
    name: 'agent_exec',
    description: 'Run a command and return a compact digest that PRESERVES all failures (+ tail). 100KB logs become ~2KB. Returns receipt to fetch the exact original via agent_savings(log_id). Use instead of Bash+tail for tests/builds.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        wait_ms: { type: 'integer', description: 'sleep before running the command (default 0)' },
        timeout_ms: { type: 'integer', description: 'default 30000' },
        until: { type: 'string', description: 'regex; adds note if no match in output' },
        digest: { type: 'boolean', description: 'compact output (default true); false = raw' },
        keep_full: { type: 'boolean', description: 'save full log + receipt (default true)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'agent_git',
    description: 'One-call git state: branch, upstream, ahead/behind, dirty files, diffstat, recent commits, stash, merge state. Use instead of git status/log/diff/stash chains.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'repo dir (default cwd)' },
      },
    },
  },
  {
    name: 'agent_savings',
    description: 'Savings ledger: calls avoided (counted), bytes returned (measured), bytes avoided (estimated), tokens. Also fetches full logs by receipt: pass log_id.',
    inputSchema: {
      type: 'object',
      properties: {
        reset: { type: 'boolean', description: 'clear ledger entries' },
        log_id: { type: 'string', description: 'receipt id from agent_exec' },
        log_offset: { type: 'integer' },
        log_limit: { type: 'integer' },
      },
    },
  },
];

function textResult(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify({ ts: new Date().toISOString(), ...data }, null, 2) }], isError };
}

let stdinDone = false;
let pending = 0;
export function serveMCP() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const raw = line.trim();
    if (!raw) return;
    let msg;
    try { msg = JSON.parse(raw); } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    if (msg.method === 'initialize') {
      write({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'toke-local', version: VERSION },
          instructions: 'Prefer these aggregate tools over native Glob/Grep/Read/Bash/git chains. agent_search→agent_read→agent_edit for code changes; agent_exec for command output digests; agent_git for repo state in one call.',
        },
      });
      return;
    }
    if (msg.method === 'notifications/initialized') return;
    if (msg.method === 'tools/list') {
      write({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      return;
    }
    if (msg.method === 'tools/call') {
      const { name } = msg.params || {};
      const args = (msg.params && msg.params.arguments) || {};
      pending++;
      let data;
      try {
        data = await dispatch(name, args);
      } catch (err) {
        data = textResult({ ok: false, error: 'internal', message: err.message }, true);
      }
      pending--;
      write({ jsonrpc: '2.0', id: msg.id, result: data });
      if (stdinDone && pending === 0) process.exit(0);
      return;
    }
    if (msg.id !== undefined && msg.id !== null) write({ jsonrpc: '2.0', id: msg.id, result: {} });
  });
  rl.on('close', () => { stdinDone = true; if (pending === 0) process.exit(0); });
  process.stdin.on('end', () => { stdinDone = true; if (pending === 0) process.exit(0); });
}

async function dispatch(name, args) {
  const reqStr = (a) => (typeof args[a] === 'string' ? args[a] : null);
  switch (name) {
    case 'agent_search':
      return textResult(await agentSearch({
        query: reqStr('query') || '???',
        root: reqStr('root') || process.cwd(),
        max_results: args.max_results || 12,
        context_lines: args.context_lines || 1,
        file_pattern: reqStr('file_pattern'),
      }));
    case 'agent_read':
      return textResult(agentRead({ file: reqStr('file') || './', mode: reqStr('mode') || 'structure' }));
    case 'agent_edit':
      return textResult(agentEdit({
        edits: args.edits, validate: args.validate !== false, cwd: reqStr('cwd') || process.cwd(),
      }), false);
    case 'agent_exec':
      return textResult(await agentExec({
        command: reqStr('command') || '', args: (args.args || []).map(String), cwd: reqStr('cwd'),
        waitMs: args.wait_ms || 0, timeoutMs: args.timeout_ms || 30000, until: reqStr('until'),
        digest: args.digest !== false, keepFull: args.keep_full !== false,
      }));
    case 'agent_git':
      return textResult(await agentGit({ cwd: reqStr('cwd') || process.cwd() }));
    case 'agent_savings':
      return textResult(agentSavings({
        reset: !!args.reset, log_id: reqStr('log_id'),
        log_offset: args.log_offset, log_limit: args.log_limit,
      }));
    default:
      return textResult({ error: `unknown tool ${name}` }, true);
  }
}

function write(o) {
  process.stdout.write(JSON.stringify(o) + '\n');
}