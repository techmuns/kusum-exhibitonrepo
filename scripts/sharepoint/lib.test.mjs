// Unit tests for the SharePoint table parser (scripts/sharepoint/lib.mjs). Pure, no network/deps.
// Run: node scripts/sharepoint/lib.test.mjs
import assert from 'node:assert/strict';
import { parseTable, mapColumnsFromNorm, buildCatalog, isOpportunity, validateProducts } from './lib.mjs';

let pass = 0; const ok = (n, fn) => { try { fn(); pass++; console.log(`PASS  ${n}`); } catch (e) { console.log(`FAIL  ${n}\n      ${e.message}`); process.exitCode = 1; } };
const norm = (cells) => cells.map((c) => String(c).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());

/* ---- column fuzzy-mapping ---- */
ok('maps canonical headers', () => {
  const m = mapColumnsFromNorm(norm(['Customer Name', 'Article No', 'Base Fabric', 'End Use', 'Industry']));
  assert.equal(m.customer, 0); assert.equal(m.item, 1); assert.equal(m.material, 2); assert.equal(m.application, 3); assert.equal(m.segment, 4);
});
ok('maps fuzzy synonyms (Party/Item Code/Composition/Usage/Market Segment)', () => {
  const m = mapColumnsFromNorm(norm(['Party', 'Item Code', 'Composition', 'Usage', 'Market Segment']));
  assert.equal(m.customer, 0); assert.equal(m.item, 1); assert.equal(m.material, 2); assert.equal(m.application, 3); assert.equal(m.segment, 4);
});
ok('a lone "Material" column binds to material, not item', () => {
  const m = mapColumnsFromNorm(norm(['Client', 'Material', 'End-Use']));
  assert.equal(m.customer, 0); assert.equal(m.material, 1); assert.equal(m.application, 2); assert.equal(m.item, -1);
});
ok('unrelated headers map to nothing (no false grabs)', () => {
  const m = mapColumnsFromNorm(norm(['Date', 'Qty (kg)', 'Rate', 'Amount']));
  assert.deepEqual(m, { customer: -1, item: -1, material: -1, application: -1, segment: -1 });
});

/* ---- parseTable: header auto-detect + row extraction ---- */
const salesGrid = [
  ['Kusumgar Corporates — Sales Register', '', '', '', ''],
  ['', '', '', '', ''],
  ['Customer Name', 'Article No', 'Base Fabric', 'End Use', 'Industry'],
  ['Acme Marine', 'KC-101', 'Nylon 66', 'Boat covers', 'Marine'],
  ['Acme Marine', 'KC-102', 'Polyester', 'Sail cloth', 'Marine'],
  ['BlueSky Defence', 'KC-101', 'Nylon 66', 'Parachutes', 'Defence'],
  ['', '', '', '', ''],
  ['Total', '', '', '', ''],
];
ok('detects the header row below title/blank rows', () => {
  const p = parseTable(salesGrid);
  assert.equal(p.headerIndex, 2);
  assert.deepEqual(p.mappedNames, { customer: 'Customer Name', item: 'Article No', material: 'Base Fabric', application: 'End Use', segment: 'Industry' });
});
ok('extracts data rows, skipping blank + total rows', () => {
  const p = parseTable(salesGrid);
  assert.equal(p.records.length, 3);
  assert.deepEqual(p.records[0], { customer: 'Acme Marine', item: 'KC-101', material: 'Nylon 66', application: 'Boat covers', segment: 'Marine' });
});
ok('returns headerIndex -1 when no recognizable table', () => {
  const p = parseTable([['Date', 'Qty', 'Rate'], ['2026-01-01', '10', '5']]);
  assert.equal(p.headerIndex, -1); assert.equal(p.records.length, 0);
});

/* ---- buildCatalog: real aggregation, nothing invented ---- */
ok('builds products grouped by code with a real customer_count', () => {
  const recs = parseTable(salesGrid).records.map((r) => ({ ...r, _file: 'sales.xlsx' }));
  const { products, customers, opportunities } = buildCatalog(recs, []);
  assert.equal(products.length, 2);
  const kc101 = products.find((p) => p.code === 'KC-101');
  assert.equal(kc101.customer_count, 2);                       // Acme + BlueSky
  assert.equal(kc101.source, 'client-sharepoint');
  assert.deepEqual(kc101.segments.sort(), ['Defence', 'Marine']);
  assert.ok(kc101.applications.includes('Boat Covers') && kc101.applications.includes('Parachutes'));
  const kc102 = products.find((p) => p.code === 'KC-102');
  assert.equal(kc102.customer_count, 1);
  assert.equal(opportunities.length, 0);
  // customers
  assert.equal(customers.length, 2);
  const acme = customers.find((c) => c.name === 'Acme Marine');
  assert.equal(acme.products.length, 2);
  assert.deepEqual(acme.applications.sort(), ['Boat Covers', 'Sail Cloth']);
});
ok('every product/customer field traces to a real input cell (no fabrication)', () => {
  const recs = parseTable(salesGrid).records.map((r) => ({ ...r, _file: 'sales.xlsx' }));
  const { products } = buildCatalog(recs, []);
  const inputCells = new Set(salesGrid.flat().map((s) => String(s)));
  for (const p of products) {
    for (const seg of p.segments) assert.ok(inputCells.has(seg), `segment "${seg}" not in input`);
    assert.ok(inputCells.has(p.code), `code "${p.code}" not in input`);
    assert.equal(p.deniers, '');                                // unknown-from-sales-table stays EMPTY, never invented
    assert.deepEqual(p.coatings, []);
  }
});
ok('reuses an existing stable id when the code matches', () => {
  const recs = parseTable(salesGrid).records.map((r) => ({ ...r, _file: 'sales.xlsx' }));
  const existing = [{ id: 'legacy-kc-101', code: 'KC-101', name: 'KC-101', kind: 'existing' }];
  const { products } = buildCatalog(recs, existing);
  assert.equal(products.find((p) => p.code === 'KC-101').id, 'legacy-kc-101');
});

/* ---- IT = future opportunities, never mixed into existing customers ---- */
const itGrid = [
  ['Customer', 'Segment', 'Application', 'Material'],
  ['FutureCo EV', 'IT', 'Automotive/EV battery wrap', 'Aramid'],
  ['WhiteGoods Ltd', 'IT', 'White Goods insulation', 'Glass'],
];
ok('isOpportunity: segment "IT" or an IT-named file', () => {
  assert.equal(isOpportunity({ segment: 'IT' }, 'anything.xlsx'), true);
  assert.equal(isOpportunity({ segment: 'Marine' }, 'IT Opportunities.xlsx'), true);
  assert.equal(isOpportunity({ segment: 'Marine' }, 'Sales-Unit.xlsx'), false);   // "unit" must NOT trigger
});
ok('IT rows become opportunities, not customers/products', () => {
  const recs = parseTable(itGrid).records.map((r) => ({ ...r, _file: 'IT.xlsx' }));
  const { products, customers, opportunities } = buildCatalog(recs, []);
  assert.equal(products.length, 0);
  assert.equal(customers.length, 0);
  assert.equal(opportunities.length, 2);
  const fc = opportunities.find((o) => o.name === 'FutureCo EV');
  assert.ok(fc.applications.includes('Automotive/ev Battery Wrap') || fc.applications[0].startsWith('Automotive'));
});
ok('mixed files: existing stay existing, IT stays opportunities (no cross-contamination)', () => {
  const recs = [
    ...parseTable(salesGrid).records.map((r) => ({ ...r, _file: 'sales.xlsx' })),
    ...parseTable(itGrid).records.map((r) => ({ ...r, _file: 'IT.xlsx' })),
  ];
  const { products, customers, opportunities } = buildCatalog(recs, []);
  assert.equal(products.length, 2);
  assert.equal(customers.length, 2);
  assert.equal(opportunities.length, 2);
  assert.ok(!customers.some((c) => /FutureCo|WhiteGoods/.test(c.name)));   // IT targets never leak into existing customers
});

/* ---- validation gate ---- */
ok('validateProducts: valid non-empty passes, empty/malformed fails', () => {
  const good = buildCatalog(parseTable(salesGrid).records.map((r) => ({ ...r, _file: 'x.xlsx' })), []).products;
  assert.equal(validateProducts(good), true);
  assert.equal(validateProducts([]), false);
  assert.equal(validateProducts([{ id: 'x', name: 'X', family: 'F', segments: [], applications: [] }]), false); // missing customer_count
});

console.log(`\n${process.exitCode ? '❌ FAILURES' : `✅ ALL ${pass} SHAREPOINT PARSER TESTS PASS`}`);
