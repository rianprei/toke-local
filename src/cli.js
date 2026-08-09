'use strict';

import { serveMCP } from './server.js';
import { agentSearch } from './tools/search.js';
import { agentRead } from './tools/read.js';
import { agentEdit } from './tools/edit.js';
import { agentExec, agentGit } from './tools/exec.js';
import { agentSavings } from './tools/savings.js';

const cmd = process.argv[2];
const argStr = process.argv[3];
let args = {};
try { args = argStr ? JSON.parse(argStr) : {}; } catch {}

async function main() {
  switch (cmd) {
    case 'mcp':
    case undefined:
    case null:
      serveMCP();
      return;
    case 'search': return console.log(JSON.stringify(await agentSearch({ query: args.query, root: args.root, max_results: args.max_results, context_lines: args.context_lines, file_pattern: args.file_pattern }), null, 2));
    case 'read': return console.log(JSON.stringify(agentRead({ file: args.file, mode: args.mode }), null, 2));
    case 'edit': return console.log(JSON.stringify(agentEdit({ edits: args.edits, validate: args.validate, cwd: args.cwd }), null, 2));
    case 'exec': {
      const a = { ...args };
      if (a.timeout_ms !== undefined) { a.timeoutMs = a.timeout_ms; delete a.timeout_ms; }
      if (a.wait_ms !== undefined) { a.waitMs = a.wait_ms; delete a.wait_ms; }
      if (a.keep_full !== undefined) { a.keepFull = a.keep_full; delete a.keep_full; }
      return console.log(JSON.stringify(await agentExec(a), null, 2));
    }
    case 'git': return console.log(JSON.stringify(await agentGit({ cwd: args.cwd }), null, 2));
    case 'savings': return console.log(JSON.stringify(agentSavings(args), null, 2));
    default:
      console.error(`unknown command ${cmd}\nusage: toke-local mcp|search|read|edit|exec|git|savings [json-args]`);
      process.exit(2);
  }
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });