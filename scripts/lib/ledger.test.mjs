// Unit tests for the shared re-check ledger. Run: node --test scripts/lib/ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { loadLedger, saveLedger, isDue, markChecked } from './ledger.mjs';

const DAY = 86_400_000;

test('a never-seen key is always due', () => {
  const led = { version: 1, entries: {} };
  assert.equal(isDue(led, 'anything'), true);
});

test('markChecked(ok) makes a key NOT due inside the success window, then due after it', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const led = markChecked({ version: 1, entries: {} }, 'show-1', { ok: true, successDays: 30, now });
  assert.equal(isDue(led, 'show-1', now + 5 * DAY), false);   // 5 days later: still fresh
  assert.equal(isDue(led, 'show-1', now + 31 * DAY), true);   // 31 days later: due again
});

test('a failed check retries sooner (failDays) than a successful one (successDays)', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const led = markChecked({ version: 1, entries: {} }, 'lead-9', { ok: false, successDays: 60, failDays: 7, now });
  assert.equal(isDue(led, 'lead-9', now + 3 * DAY), false);   // within 7-day fail window
  assert.equal(isDue(led, 'lead-9', now + 8 * DAY), true);    // after the fail window
});

test('attempts counter increments across checks', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  let led = markChecked({ version: 1, entries: {} }, 'k', { ok: false, now });
  led = markChecked(led, 'k', { ok: false, now: now + DAY });
  assert.equal(led.entries['k'].attempts, 2);
});

test('load/save round-trips through a file and preserves due-ness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
  const path = join(dir, 'ck.json');
  try {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const led = markChecked({ version: 1, entries: {} }, 'cat-a', { ok: true, successDays: 30, now });
    assert.equal(await saveLedger(path, led), true);
    const back = await loadLedger(path);
    assert.equal(isDue(back, 'cat-a', now + 5 * DAY), false);
    assert.equal(isDue(back, 'cat-a', now + 40 * DAY), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a missing ledger file is fail-safe: fresh ledger, everything due', async () => {
  const led = await loadLedger(join(tmpdir(), 'does-not-exist-xyz.json'));
  assert.deepEqual(led, { version: 1, entries: {} });
  assert.equal(isDue(led, 'whatever'), true);
});

test('a corrupt ledger file is fail-safe: treated as fresh (everything due)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
  const path = join(dir, 'bad.json');
  try {
    await writeFile(path, '{ this is not valid json ');
    const led = await loadLedger(path);
    assert.deepEqual(led, { version: 1, entries: {} });
    assert.equal(isDue(led, 'x'), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
