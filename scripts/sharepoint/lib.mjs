// scripts/sharepoint/lib.mjs — pure, dependency-free helpers for the SharePoint product/customer importer.
// No npm packages here (only node:crypto) so they can be unit-tested without playwright/xlsx/etc.
//
// The SharePoint LOGIN + URL parsing helpers are ported verbatim from the proven kusumgarcr importer.
// The TABLE PARSER (parseTable/buildCatalog) is new: these are clean sales/usage tables, so we read the
// columns DIRECTLY (auto-detect the header row, fuzzy-map columns) — no AI guessing, nothing invented.
import crypto from 'node:crypto';

/* ---- TOTP (RFC 6238), for the optional SHAREPOINT_TOTP MFA path (unused when the account has no MFA) ---- */
export function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of String(s || '').replace(/=+$/g, '').toUpperCase().replace(/\s+/g, '')) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export function totp(secret, forTimeMs = Date.now(), step = 30, digits = 6) {
  try {
    const key = base32Decode(secret);
    if (!key.length) return '';
    const counter = Math.floor(forTimeMs / 1000 / step);
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const off = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
    return String(code % 10 ** digits).padStart(digits, '0');
  } catch { return ''; }
}

/* ---- SharePoint URL parsing (ported verbatim) ---- */
export function parseSharePointUrl(u) {
  const url = new URL(u);
  const origin = url.origin;
  const idParam = url.searchParams.get('id') || url.searchParams.get('RootFolder');
  let folder;
  if (idParam) {
    folder = idParam; // already percent-decoded by URLSearchParams
  } else {
    try { folder = decodeURIComponent(url.pathname); } catch { folder = url.pathname; }
    folder = folder.replace(/^\/:[a-z]:\/[a-z]\//i, '/');
    folder = folder.replace(/\/forms\/[^/]+\.aspx$/i, '').replace(/\/[^/]+\.aspx$/i, '');
  }
  folder = folder.replace(/\/+$/, '') || '/';
  const segs = folder.split('/').filter(Boolean);
  let siteApi = origin;
  const s0 = (segs[0] || '').toLowerCase();
  if ((s0 === 'sites' || s0 === 'teams' || s0 === 'personal') && segs[1]) siteApi = `${origin}/${segs[0]}/${segs[1]}`;
  return { origin, siteApi, serverRelativeFolder: folder };
}
// Single-quote a server-relative path for OData (SharePoint doubles ').
export const odataQuote = (p) => `'${encodeURIComponent(String(p).replace(/'/g, "''"))}'`;

/* ---- supported file types (sales tables only: no pdf/docx here) ---- */
export const SUPPORTED = ['.xlsx', '.xls', '.csv'];
export const extOf = (name) => { const m = String(name || '').toLowerCase().match(/\.[a-z0-9]+$/); return m ? m[0] : ''; };
export const isSupported = (name) => SUPPORTED.includes(extOf(name));

/* ---- small text helpers ---- */
export const slugify = (s) => String(s || '')
  .toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
export const normKey = (s) => String(s || '')
  .toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const titleCase = (s) => String(s || '').trim().replace(/\s+/g, ' ')
  .replace(/\b([a-z])/g, (m) => m.toUpperCase());
const uniq = (a) => [...new Set(a.filter((x) => x != null && String(x).trim() !== ''))];
const normCell = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ---- column fuzzy-mapping (customer / item / material / application / segment) ---- */
// Synonyms per logical column. Multi-word phrases are matched as whole tokens so "material code" -> item,
// but a plain "material" -> material (see scoreHeader).
export const COLUMN_SYNONYMS = {
  customer: ['customer', 'customer name', 'party', 'party name', 'client', 'buyer', 'account', 'account name', 'company', 'sold to', 'name of customer', 'customer / party'],
  item: ['item', 'item code', 'item name', 'item description', 'item no', 'code', 'article', 'article no', 'article number', 'sku', 'product', 'product code', 'product name', 'grade', 'quality', 'material code', 'style', 'construction code'],
  material: ['material', 'base', 'base fabric', 'base material', 'fabric', 'substrate', 'yarn', 'composition', 'construction', 'fibre', 'fiber', 'raw material'],
  application: ['application', 'applications', 'end use', 'end uses', 'end-use', 'enduse', 'usage', 'use', 'end application', 'application area', 'end use application', 'purpose'],
  segment: ['segment', 'industry', 'sector', 'category', 'market', 'vertical', 'business segment', 'end segment', 'market segment'],
};
// Score how well a normalized header cell `h` matches a field's synonyms. Whole-token / exact / edge
// matches score >= 2 (accepted); a mere long substring scores 1 (rejected) so coincidences don't grab a column.
function scoreHeader(h, syns) {
  let sc = 0;
  const hz = ` ${h} `;
  for (const syn of syns) {
    if (h === syn) sc = Math.max(sc, 3);
    else if (hz.includes(` ${syn} `)) sc = Math.max(sc, 2);
    else if (syn.length >= 4 && (h.startsWith(`${syn} `) || h.endsWith(` ${syn}`))) sc = Math.max(sc, 2);
    else if (syn.length >= 5 && h.includes(syn)) sc = Math.max(sc, 1);
  }
  return sc;
}
// Map a row of normalized header cells to column indices. Fields are resolved in priority order and a
// column, once taken, can't be reused. A field only binds on score >= 2 (a confident match).
export function mapColumnsFromNorm(normHeaderCells) {
  const used = new Set();
  const pick = (syns) => {
    let best = -1, bestScore = 1; // must beat 1 -> only >= 2 accepted
    for (let i = 0; i < normHeaderCells.length; i++) {
      if (used.has(i) || !normHeaderCells[i]) continue;
      const sc = scoreHeader(normHeaderCells[i], syns);
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    if (best >= 0) used.add(best);
    return best;
  };
  return {
    customer: pick(COLUMN_SYNONYMS.customer),
    item: pick(COLUMN_SYNONYMS.item),
    material: pick(COLUMN_SYNONYMS.material),
    application: pick(COLUMN_SYNONYMS.application),
    segment: pick(COLUMN_SYNONYMS.segment),
  };
}

/* ---- parse ONE sheet's raw rows (array-of-arrays) into records ---- */
// Auto-detects the header row (best of the first 15 non-empty rows), maps columns, and pulls the data
// rows below it. Returns { headerIndex:-1, records:[] } when no recognizable header is found (never guesses).
export function parseTable(rows) {
  const scanN = Math.min((rows || []).length, 15);
  let best = null;
  for (let r = 0; r < scanN; r++) {
    const cells = (rows[r] || []).map((c) => String(c == null ? '' : c).trim());
    if (!cells.some(Boolean)) continue;
    const norm = cells.map(normCell);
    const mapping = mapColumnsFromNorm(norm);
    const mapped = Object.values(mapping).filter((i) => i >= 0).length;
    const anchor = mapping.customer >= 0 || mapping.item >= 0; // a real table has a customer or an item column
    if (anchor && mapped >= 2) {
      const score = mapped + (mapping.customer >= 0 ? 1 : 0) + (mapping.item >= 0 ? 1 : 0);
      if (!best || score > best.score) best = { r, mapping, cells, score };
    }
  }
  if (!best) return { headerIndex: -1, mapping: {}, mappedNames: {}, records: [] };
  const { r: headerIndex, mapping, cells } = best;
  const mappedNames = {};
  for (const f of ['customer', 'item', 'material', 'application', 'segment']) if (mapping[f] >= 0) mappedNames[f] = cells[mapping[f]];
  const get = (row, i) => (i >= 0 ? String((row || [])[i] == null ? '' : (row || [])[i]).trim() : '');
  const records = [];
  for (let r = headerIndex + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const rec = {
      customer: get(row, mapping.customer), item: get(row, mapping.item), material: get(row, mapping.material),
      application: get(row, mapping.application), segment: get(row, mapping.segment),
    };
    if (!rec.customer && !rec.item && !rec.material) continue;                 // blank row
    if (normCell(rec.customer) === 'customer' || normCell(rec.item) === 'item') continue; // repeated header
    if (/^(total|grand total|sum|subtotal)\b/i.test(rec.customer) && !rec.item) continue;  // total row
    records.push(rec);
  }
  return { headerIndex, mapping, mappedNames, records };
}

/* ---- IT = future opportunities, not existing customers ---- */
export function isOpportunity(rec, fileName) {
  const seg = String((rec && rec.segment) || '').trim();
  if (/^it$/i.test(seg)) return true;                                          // segment cell literally "IT"
  const base = String(fileName || '').replace(/\.[a-z0-9]+$/i, '');
  return /(^|[^a-z])it([^a-z]|$)/i.test(base);                                 // a file named "IT", "IT Opportunities", …
}

/* ---- build the product catalog + customer list + opportunities from parsed records ---- */
// records: [{ customer, item, material, application, segment, _file }]. `existing` is the current
// products.json list, used ONLY to reuse a product's stable id across weekly syncs (match on code, then
// name) so nothing silently renames. Nothing here invents data — every field traces to a real cell.
export function buildCatalog(records, existing = []) {
  const rows = (records || []).filter((r) => r && (r.customer || r.item || r.material));
  const existingList = Array.isArray(existing) ? existing : (existing && existing.products) || [];
  // existing id lookups
  const idByCode = new Map(); const idByName = new Map();
  for (const e of existingList) {
    if (!e || !e.id) continue;
    const ck = e.code ? normKey(e.code) : '';
    const nk = e.name ? normKey(e.name) : '';
    if (ck && !idByCode.has(ck)) idByCode.set(ck, String(e.id));
    if (nk && !idByName.has(nk)) idByName.set(nk, String(e.id));
  }

  const existingRows = []; const oppRows = [];
  for (const r of rows) (isOpportunity(r, r._file) ? oppRows : existingRows).push(r);

  // ----- products (existing rows), keyed by item code when present, else by material -----
  const prodMap = new Map(); const prodOrder = [];
  for (const r of existingRows) {
    const code = r.item ? String(r.item).trim() : '';
    const material = r.material ? titleCase(r.material) : '';
    const name = code || material;
    if (!name) continue;                                                       // nothing identifiable → skip (never invent)
    const key = code ? `c:${normKey(code)}` : `m:${normKey(material)}`;
    if (!prodMap.has(key)) { prodMap.set(key, { code, name, material, segments: new Set(), applications: new Set(), customers: new Set() }); prodOrder.push(key); }
    const p = prodMap.get(key);
    if (!p.material && material) p.material = material;
    if (r.segment) p.segments.add(titleCase(r.segment));
    if (r.application) p.applications.add(titleCase(r.application));
    if (r.customer) p.customers.add(String(r.customer).trim());
  }
  // stable ids: reuse existing by code, then name; else fresh slug (unique).
  const usedIds = new Set();
  const claim = (pref, fb) => {
    for (const c of [pref, fb]) if (c && !usedIds.has(c)) { usedIds.add(c); return c; }
    let id = fb || pref || 'product'; let n = 2;
    while (usedIds.has(id)) id = `${fb || pref || 'product'}-${n++}`;
    usedIds.add(id); return id;
  };
  const products = prodOrder.map((key) => {
    const p = prodMap.get(key);
    const ck = p.code ? normKey(p.code) : '';
    const nk = normKey(p.name);
    const reuse = (ck && idByCode.get(ck)) || idByName.get(nk) || '';
    const fallback = p.code ? `${slugify(p.material) || 'product'}-${slugify(p.code)}` : (slugify(p.name) || 'product');
    const out = {
      id: claim(reuse, fallback),
      family: p.material || 'Other',
      name: p.name,
      base: p.material || '',
      deniers: '',                                                             // unknown from a sales table — left empty, never invented
      coatings: [],
      properties: [],
      segments: uniq([...p.segments]),
      applications: uniq([...p.applications]),
      customer_count: p.customers.size,
      source: 'client-sharepoint',
      kind: 'existing',
    };
    if (p.code) out.code = p.code;
    return out;
  });
  // map product name/code -> id, for the customers' product references
  const prodIdByName = new Map(); const prodIdByCode = new Map();
  for (const key of prodOrder) { const p = prodMap.get(key); const id = products[prodOrder.indexOf(key)].id; prodIdByName.set(normKey(p.name), id); if (p.code) prodIdByCode.set(normKey(p.code), id); }

  // ----- existing customers -----
  const custMap = new Map(); const custOrder = [];
  for (const r of existingRows) {
    const name = r.customer ? String(r.customer).trim() : '';
    if (!name) continue;
    const key = normKey(name);
    if (!custMap.has(key)) { custMap.set(key, { name, segments: new Set(), applications: new Set(), products: new Set() }); custOrder.push(key); }
    const c = custMap.get(key);
    if (r.segment) c.segments.add(titleCase(r.segment));
    if (r.application) c.applications.add(titleCase(r.application));
    const pid = (r.item && prodIdByCode.get(normKey(r.item))) || (r.item && prodIdByName.get(normKey(r.item))) || (r.material && prodIdByName.get(normKey(titleCase(r.material)))) || '';
    if (pid) c.products.add(pid);
  }
  const customers = custOrder.map((key) => {
    const c = custMap.get(key);
    return { name: c.name, segments: uniq([...c.segments]), applications: uniq([...c.applications]), products: uniq([...c.products]) };
  });

  // ----- future opportunities (IT rows) -----
  const oppMap = new Map(); const oppOrder = [];
  for (const r of oppRows) {
    const label = String(r.customer || r.application || r.material || r.item || '').trim();
    if (!label) continue;
    const key = normKey(label);
    if (!oppMap.has(key)) { oppMap.set(key, { name: label, segments: new Set(), applications: new Set(), materials: new Set() }); oppOrder.push(key); }
    const o = oppMap.get(key);
    if (r.segment && !/^it$/i.test(r.segment.trim())) o.segments.add(titleCase(r.segment));
    if (r.application) o.applications.add(titleCase(r.application));
    if (r.material) o.materials.add(titleCase(r.material));
  }
  const opportunities = oppOrder.map((key) => {
    const o = oppMap.get(key);
    return { name: o.name, segments: uniq([...o.segments]), applications: uniq([...o.applications]), materials: uniq([...o.materials]) };
  });

  return { products, customers, opportunities };
}

/* ---- validation: only ever write on a valid, non-empty product parse ---- */
export function validateProducts(products) {
  return Array.isArray(products) && products.length > 0 && products.every((p) =>
    p && typeof p === 'object'
    && typeof p.id === 'string' && p.id
    && typeof p.name === 'string' && p.name
    && typeof p.family === 'string'
    && Array.isArray(p.segments) && Array.isArray(p.applications)
    && Number.isInteger(p.customer_count));
}
