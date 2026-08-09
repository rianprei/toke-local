'use strict';

import { tsHeader } from '../util.js';
import { Ledger } from '../ledger.js';

export function agentSavings({ reset = false, log_id, log_offset, log_limit, days } = {}) {
  const led = new Ledger();
  if (reset) {
    led.data.entries = [];
    led._save();
  }
  if (log_id) {
    const content = led.readLog(log_id);
    if (content === null) return { _ts: tsHeader(), ok: false, error: 'log_not_found', message: `no receipt ${log_id}` };
    const offset = log_offset || 0;
    const limit = log_limit || 200;
    const out = content.split('\n').slice(offset, offset + limit).join('\n');
    return { _ts: tsHeader(), ok: true, log_id, offset, limit, total_lines: content.split('\n').length, text: out };
  }
  const stats = led.stats({ days });
  return { _ts: tsHeader(), ok: true, window_days: days || null, ...stats };
}