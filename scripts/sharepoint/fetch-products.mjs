// scripts/sharepoint/fetch-products.mjs — auto-import the REAL Kusumgar product list + existing-customer
// list from the client's SharePoint folder and rebuild public/data/products.json + customers.json.
//
// Ported from the proven kusumgarcr importer: the SharePoint LOGIN + DOWNLOAD + all the safety are
// identical. What's DIFFERENT: these are clean sales/usage tables, so we parse the columns DIRECTLY
// (auto-detect header, fuzzy-map columns) — NO AI. Nothing is invented; every value traces to a real cell.
//
// Isolated & safe by design:
//   • Logs in with username+password via Playwright (Microsoft flow); MFA-aware (optional TOTP; the
//     account has no MFA so the TOTP path just won't trigger).
//   • NEVER HANGS: every step has a hard timeout; a login/verification wall logs clearly and exits 0.
//   • NEVER BLANKS / NEVER PARTIAL: products.json/customers.json are only overwritten on a valid, non-empty
//     parse; if ANY file can't be read the whole run aborts and writes nothing (job goes red).
//   • Saves a screenshot of a login/MFA wall (sharepoint-debug.png) — never of authenticated client content.
//   • Preserves the separately-managed kind:"new" products (carbon-fibre etc.) — only kind:"existing" is replaced.
//
// Heavy deps (playwright, xlsx) are dynamically imported so this file loads without them; the workflow installs them.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  totp, parseSharePointUrl, odataQuote, isSupported, extOf,
  parseTable, buildCatalog, validateProducts,
} from './lib.mjs';

const USER = process.env.SHAREPOINT_USER || '';
const PASS = process.env.SHAREPOINT_PASS || '';
const FOLDER_URL = process.env.SHAREPOINT_FOLDER_URL || '';
const TOTP = process.env.SHAREPOINT_TOTP || '';
const SHOT = 'sharepoint-debug.png';
const PRODUCTS_PATH = process.env.KGR_PRODUCTS_PATH || fileURLToPath(new URL('../../public/data/products.json', import.meta.url));
const CUSTOMERS_PATH = process.env.KGR_CUSTOMERS_PATH || fileURLToPath(new URL('../../public/data/customers.json', import.meta.url));

const log = (m) => console.log(`[sharepoint] ${m}`);

/* ------------------------------- login helpers (ported verbatim) ------------------------------- */
async function tryFill(page, selectors, value, timeout = 8000) {
  for (const sel of selectors) {
    try { const el = page.locator(sel).first(); await el.waitFor({ state: 'visible', timeout }); await el.fill(value); return true; } catch { /* next */ }
  }
  return false;
}
async function tryClick(page, selectors, timeout = 8000) {
  for (const sel of selectors) {
    try { const el = page.locator(sel).first(); await el.waitFor({ state: 'visible', timeout }); await el.click(); return true; } catch { /* next */ }
  }
  return false;
}
async function isVisible(page, selector, timeout = 3000) {
  try { await page.locator(selector).first().waitFor({ state: 'visible', timeout }); return true; } catch { return false; }
}
async function detectMfa(page) {
  if (await isVisible(page, 'input[name=otc]', 2500) || await isVisible(page, '#idTxtBx_SAOTCC_OTC', 1000)) return 'otp';
  let host = '';
  try { host = new URL(page.url()).host.toLowerCase(); } catch { /* ignore */ }
  const onLoginHost = /(^|\.)login\.(microsoftonline|live|windows|microsoft)\.com$/.test(host)
    || host.endsWith('.b2clogin.com') || host === 'login.microsoftonline.us';
  if (!onLoginHost) return '';
  if (await isVisible(page, '#idRemoteNGC_DisplaySign, #idDiv_SAOTCAS_Title, #idSpan_SAOTCAS_TD_Tag', 800)) return 'approval';
  const body = (await page.textContent('body').catch(() => '') || '').toLowerCase();
  const walls = ['approve sign in', 'approve the request', 'open your authenticator', 'enter the number shown',
    'verify your identity', "verify it's you", 'we sent a notification', 'more information required',
    'additional security verification', 'authenticator app'];
  return walls.some((w) => body.includes(w)) ? 'approval' : '';
}
async function signIn(page) {
  await page.goto(FOLDER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!(await isVisible(page, 'input[type=email], input[name=loginfmt]', 6000))) {
    if (!(await detectMfa(page))) return { blocked: '' };
  }
  await tryFill(page, ['input[type=email]', 'input[name=loginfmt]'], USER);
  await tryClick(page, ['#idSIButton9', 'input[type=submit]', 'button:has-text("Next")']);
  await page.waitForTimeout(1800);
  await tryFill(page, ['input[type=password]', 'input[name=passwd]', 'input[type=password i]'], PASS);
  await tryClick(page, ['#idSIButton9', 'button:has-text("Sign in")', 'input[type=submit]']);
  await page.waitForTimeout(2800);

  const mfa = await detectMfa(page);
  if (mfa === 'otp' && TOTP) {
    const code = totp(TOTP);
    log(`MFA code screen — entering TOTP (${code ? 'generated' : 'FAILED to generate'})`);
    if (code) {
      await tryFill(page, ['input[name=otc]', '#idTxtBx_SAOTCC_OTC', 'input[type=tel]'], code);
      await tryClick(page, ['#idSubmit_SAOTCC_Continue', '#idSIButton9', 'button:has-text("Verify")', 'input[type=submit]']);
      await page.waitForTimeout(2800);
    }
    if (await detectMfa(page)) return { blocked: 'mfa-after-totp' };
  } else if (mfa) {
    return { blocked: mfa === 'otp' ? 'mfa-otp-no-secret' : 'mfa-approval' };
  }
  await tryClick(page, ['#idSIButton9', 'button:has-text("Yes")'], 6000);
  await page.waitForTimeout(1500);
  return { blocked: '' };
}

/* ------------------------------- SharePoint REST (ported verbatim) ------------------------------- */
const MAX_DEPTH = 40;
const rows = (j) => (j?.value || j?.d?.results || []);
const nextLink = (j) => (j && (j['odata.nextLink'] || j['@odata.nextLink'] || (j.d && j.d.__next))) || '';
async function apiFetch(request, url) {
  try {
    const res = await request.get(url, { headers: { accept: 'application/json;odata=minimalmetadata' }, timeout: 30000 });
    const status = res.status();
    if (!res.ok()) { log(`REST ${status} ${url.slice(0, 120)}`); return { status, json: null }; }
    try { return { status, json: await res.json() }; }
    catch (e) { log(`REST bad JSON (${status}) ${url.slice(0, 120)}: ${e.message}`); return { status, json: null }; }
  } catch (e) { log(`REST failed: ${e.message}`); return { status: 0, json: null }; }
}
async function apiGetAllRows(request, url) {
  const all = [];
  let next = url, pages = 0;
  while (next && pages < 1000) {
    const { json } = await apiFetch(request, next);
    if (json == null) return null;
    all.push(...rows(json));
    next = nextLink(json);
    pages++;
  }
  if (next) { log(`pagination cap hit with more pages remaining for ${url.slice(0, 120)}`); return null; }
  return all;
}
async function listFolderRecursive(request, siteApi, folderPath, depth = 0) {
  const files = [];
  const fRows = await apiGetAllRows(request, `${siteApi}/_api/web/GetFolderByServerRelativeUrl(${odataQuote(folderPath)})/Files?$select=Name,ServerRelativeUrl&$top=5000`);
  if (fRows == null) throw new Error(`could not list files in ${folderPath} (REST error) — aborting to avoid a partial import`);
  for (const f of fRows) if (isSupported(f.Name)) files.push({ name: f.Name, serverRelativeUrl: f.ServerRelativeUrl });

  const dRows = await apiGetAllRows(request, `${siteApi}/_api/web/GetFolderByServerRelativeUrl(${odataQuote(folderPath)})/Folders?$select=Name,ServerRelativeUrl&$top=5000`);
  if (dRows == null) throw new Error(`could not list subfolders in ${folderPath} (REST error) — aborting to avoid a partial import`);
  const subs = dRows.filter((d) => !String(d.Name || '').startsWith('_'));
  if (subs.length && depth >= MAX_DEPTH) throw new Error(`folder tree deeper than ${MAX_DEPTH} levels at ${folderPath} — aborting to avoid a partial import`);
  for (const d of subs) files.push(...await listFolderRecursive(request, siteApi, d.ServerRelativeUrl, depth + 1));
  return files;
}
async function download(request, siteApi, serverRelativeUrl) {
  try {
    const res = await request.get(`${siteApi}/_api/web/GetFileByServerRelativeUrl(${odataQuote(serverRelativeUrl)})/$value`, { timeout: 60000 });
    if (!res.ok()) { log(`download ${res.status()} ${serverRelativeUrl}`); return null; }
    return Buffer.from(await res.body());
  } catch (e) { log(`download failed ${serverRelativeUrl}: ${e.message}`); return null; }
}

/* ------------------------------- direct table parse (NO AI) ------------------------------- */
// Read a workbook/CSV buffer into { records:[…], mappings:[…] }. xlsx reads .xlsx/.xls/.csv the same way.
async function parseWorkbook(name, buf) {
  const xmod = await import('xlsx');
  const XLSX = xmod.default || xmod;
  const wb = XLSX.read(buf, { type: 'buffer' });
  const records = []; const mappings = [];
  for (const sheet of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: false, defval: '' });
    const parsed = parseTable(grid);
    if (parsed.headerIndex < 0) { log(`  ${name} [${sheet}]: no recognizable header row — skipped`); continue; }
    mappings.push({ file: name, sheet, mapped: parsed.mappedNames, rows: parsed.records.length });
    log(`  ${name} [${sheet}]: header@row ${parsed.headerIndex + 1} → columns ${JSON.stringify(parsed.mappedNames)} · ${parsed.records.length} data row(s)`);
    for (const rec of parsed.records) records.push({ ...rec, _file: name });
  }
  return { records, mappings };
}

/* ------------------------------- data IO ------------------------------- */
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }
const nowISO = () => new Date().toISOString();
const todayISO = () => new Date().toISOString().slice(0, 10);

/* ------------------------------- main ------------------------------- */
async function snapLogin(page, why) {
  try {
    const onLogin = await isVisible(page,
      'input[type=email], input[name=loginfmt], input[type=password], input[name=passwd], input[name=otc], #idTxtBx_SAOTCC_OTC', 2000)
      || !!(await detectMfa(page));
    if (!onLogin) { log(`skip screenshot (${why}): not a login/MFA screen — won't risk capturing client content`); return; }
    await page.screenshot({ path: SHOT, fullPage: true });
    log(`saved ${SHOT} (${why})`);
  } catch (e) { log(`screenshot skipped (${why}): ${e.message}`); }
}

async function main() {
  const report = { loginOk: false, blocked: '', files: 0, byType: {}, read: 0, products: 0, customers: 0, opportunities: 0, wrote: false, failed: false, failReason: '' };

  if (!USER || !PASS || !FOLDER_URL) { log('missing SHAREPOINT_USER / SHAREPOINT_PASS / SHAREPOINT_FOLDER_URL — nothing to do (files untouched)'); return report; }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  let authed = false;

  try {
    const { blocked } = await signIn(page);
    if (blocked) {
      report.blocked = blocked;
      await snapLogin(page, `blocked:${blocked}`);
      log(blocked.startsWith('mfa')
        ? `MFA/verification required (${blocked}) — add SHAREPOINT_TOTP or use the Graph API. files untouched.`
        : `sign-in blocked (${blocked}). files untouched.`);
      return report;                                       // expected block -> exit 0 (job stays green)
    }

    const { siteApi, serverRelativeFolder } = parseSharePointUrl(FOLDER_URL);
    const probe = await apiFetch(context.request, `${siteApi}/_api/web?$select=Title`);
    if (probe.json == null) {
      if (probe.status === 401 || probe.status === 403) {
        report.blocked = 'no-session';
        await snapLogin(page, 'no-session');
        log(`not authenticated to SharePoint REST (HTTP ${probe.status}) — bad credentials or a verification wall. files untouched.`);
        return report;                                     // expected auth block -> exit 0
      }
      report.failed = true;
      report.failReason = `SharePoint probe failed (HTTP ${probe.status || 'network/timeout'})`;
      await snapLogin(page, 'probe-failed');
      log(`could not verify the SharePoint session (${report.failReason}) — treating as a real failure. files untouched.`);
      return report;                                       // transient / server / config error -> exit 1
    }
    authed = true;
    report.loginOk = true;
    log(`signed in — site "${probe.json.Title || '?'}". Listing ${serverRelativeFolder} …`);

    const listed = await listFolderRecursive(context.request, siteApi, serverRelativeFolder);
    report.files = listed.length;
    for (const f of listed) report.byType[extOf(f.name)] = (report.byType[extOf(f.name)] || 0) + 1;
    log(`found ${listed.length} supported files: ${JSON.stringify(report.byType)}`);
    if (!listed.length) { log('no supported files found in the folder — files untouched.'); return report; }

    // Download + parse EVERY file. If even one can't be read, abort WITHOUT writing (never partial).
    const allRecords = []; const failedFiles = [];
    for (const f of listed) {
      const buf = await download(context.request, siteApi, f.serverRelativeUrl);
      if (!buf) { failedFiles.push(`${f.name} (download failed)`); continue; }
      let parsed;
      try { parsed = await parseWorkbook(f.name, buf); }
      catch (e) { failedFiles.push(`${f.name} (parse error: ${e.message})`); continue; }
      if (!parsed.mappings.length) { failedFiles.push(`${f.name} (no recognizable table / header)`); continue; }
      allRecords.push(...parsed.records);
      report.read++;
    }
    log(`read ${report.read}/${listed.length} files · ${allRecords.length} data row(s) total`);
    if (failedFiles.length) {
      report.failed = true;
      report.failReason = `could not use ${failedFiles.length} of ${listed.length} file(s): ${failedFiles.join('; ')}`;
      log(`ABORT (never partial): ${report.failReason}. Fix/remove these in SharePoint. files untouched.`);
      return report;                                       // integrity failure -> exit 1 (job goes red)
    }

    // Build the catalog directly from the rows. `existing` = the current EXISTING products (for stable id reuse).
    const curProducts = await readJson(PRODUCTS_PATH, []);
    const curList = Array.isArray(curProducts) ? curProducts : (curProducts.products || []);
    const keepNew = curList.filter((p) => p && p.kind === 'new');              // preserve the separately-managed new-product entries
    const curExisting = curList.filter((p) => p && p.kind !== 'new');
    const { products, customers, opportunities } = buildCatalog(allRecords, curExisting);
    report.products = products.length; report.customers = customers.length; report.opportunities = opportunities.length;

    if (!validateProducts(products)) {
      report.failed = true;
      report.failReason = 'parsed no valid products from the files (check the column mapping printed above)';
      log('no valid products built from the files — files untouched.');
      return report;                                       // integrity failure -> exit 1
    }

    const finalProducts = [...products, ...keepNew];        // real existing products + preserved new-product entries
    report.wroteProducts = await (async () => { await writeFile(PRODUCTS_PATH, JSON.stringify(finalProducts, null, 1) + '\n'); return true; })();

    const customersDoc = {
      generated_by: 'client-sharepoint',
      updated_at: nowISO(),
      source_note: `Imported from the client SharePoint folder — ${report.read} file(s) (${Object.entries(report.byType).map(([k, v]) => `${v}${k}`).join(', ')}) read on ${todayISO()}.`,
      customers,
      opportunities,
    };
    await writeFile(CUSTOMERS_PATH, JSON.stringify(customersDoc, null, 1) + '\n');
    report.wrote = true;
    log(`wrote products.json (${products.length} existing + ${keepNew.length} new) + customers.json (${customers.length} customers, ${opportunities.length} opportunities)`);
    return report;
  } catch (e) {
    if (!authed) await snapLogin(page, 'error-before-auth');
    report.failed = true;
    report.failReason = e.message;
    log(`unexpected error: ${e.message}`);
    return report;
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}

function printSummary(r) {
  console.log('\n[sharepoint] SUMMARY');
  console.log(`  login: ${r.loginOk ? 'SUCCESS' : (r.blocked ? `BLOCKED (${r.blocked})` : 'not attempted / failed')}`);
  console.log(`  files found: ${r.files} ${JSON.stringify(r.byType)}`);
  console.log(`  files read: ${r.read}`);
  console.log(`  products: ${r.products} · customers: ${r.customers} · opportunities: ${r.opportunities}`);
  console.log(`  files ${r.wrote ? 'UPDATED' : 'untouched'}`);
  if (r.failed) console.log(`  RESULT: FAILED — ${r.failReason}`);
  else if (r.blocked) console.log(`  RESULT: blocked (${r.blocked}) — expected; job stays green`);
  else if (!r.loginOk) console.log('  RESULT: nothing to do (missing config) — job stays green');
  else if (!r.wrote) console.log('  RESULT: ok — no changes');
  else console.log('  RESULT: ok — products.json + customers.json updated');
}

main()
  .then((r) => { printSummary(r); return r.failed ? 1 : 0; })
  .catch((e) => { console.log(`[sharepoint] unexpected error: ${e.message}`); return 1; })
  .then((code) => process.exit(code));
