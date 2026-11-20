// Shared "re-check ledger" for the weekly finder robots.
//
// Why this exists
// ---------------
// The finders run over a largely FIXED input set every week (the same trade shows,
// buyer categories, new-products, research targets, leads). Re-searching and re-reading
// the same item every week re-spends Firecrawl / Serper / Scrape.do credits for no new
// information. This ledger remembers when each item was last attempted and when it is
// next "due", so a robot skips items it checked recently and spends its per-run budget
// on genuinely-due work instead (which also cycles coverage across a larger backlog).
//
// Design (mirrors the proven public/data/exhibition-checks.json pattern)
// ----------------------------------------------------------------------
//   - One small JSON file per robot:
//       { "version": 1, "entries": { "<key>": { attempted_at, status, attempts, next_check_at } } }
//   - FAIL-SAFE: a missing or unreadable ledger is treated as "every item is due", i.e.
//     exactly the pre-ledger behaviour. The ledger can only REDUCE calls, never break a run.
//   - Never throws.

import { readFile, writeFile } from 'node:fs/promises';

const DAY_MS = 86_400_000;
const asMillis = (now) => (typeof now === 'number' ? now : Date.parse(now));

// Load a ledger; a missing/corrupt file yields a fresh ledger (everything due).
export async function loadLedger(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
      return { version: raw.version || 1, entries: raw.entries };
    }
  } catch { /* missing / corrupt -> fresh ledger (everything due) */ }
  return { version: 1, entries: {} };
}

// Persist a ledger. Never throws; returns true on success.
export async function saveLedger(path, ledger) {
  try {
    const out = { version: (ledger && ledger.version) || 1, entries: (ledger && ledger.entries) || {} };
    await writeFile(path, JSON.stringify(out, null, 1) + '\n');
    return true;
  } catch (e) {
    console.error(`[ledger] could not write ${path}: ${e && e.message}`);
    return false;
  }
}

// Due when never seen, or now >= next_check_at (a missing/unparseable next_check_at is due).
export function isDue(ledger, key, now = Date.now()) {
  const e = ledger && ledger.entries ? ledger.entries[String(key)] : null;
  if (!e || !e.next_check_at) return true;
  const due = Date.parse(e.next_check_at);
  return !Number.isFinite(due) || due <= asMillis(now);
}

// Record an attempt and schedule the next one.
//   ok=true  -> next check in successDays (default 30)
//   ok=false -> next check in failDays   (default 14) — retries sooner than successes, but NOT every run.
export function markChecked(ledger, key, { ok = true, successDays = 30, failDays = 14, now = Date.now() } = {}) {
  const t = asMillis(now);
  const days = ok ? successDays : failDays;
  const k = String(key);
  if (!ledger.entries) ledger.entries = {};
  const prev = ledger.entries[k] || {};
  ledger.entries[k] = {
    attempted_at: new Date(t).toISOString(),
    status: ok ? 'ok' : 'fail',
    attempts: (Number(prev.attempts) || 0) + 1,
    next_check_at: new Date(t + days * DAY_MS).toISOString(),
  };
  return ledger;
}
