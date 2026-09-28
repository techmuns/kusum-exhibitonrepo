// Right-person contact discovery — hunts the TECHNICAL / R&D / OPERATIONS decision-maker
// (NOT purchasing) for each target company, with their LinkedIn and a real verified email
// where free tools can get one.
//
// WHY: technical / R&D people convert; purchasing just asks price and stalls. So we rank the
// person we find by role tier and always keep the HIGHEST-tier person available:
//   Tier A (best): R&D / Research & Development, Technology or Technical Director/Head/Manager,
//                  VP/Chief Technology (CTO), Product Development, Engineering, Innovation.
//   Tier B:        Operations (also Plant / Manufacturing / Production) Head/Director/Manager.
//   Tier C (weak): Purchasing / Procurement / Sourcing / Buyer — used ONLY when no A/B exists,
//                  and flagged as weaker.
//
// FREE-FIRST + SOURCE-BACKED (mirrors verify-research-targets.mjs), Firecrawl is a booster:
//   PERSON: free website-first (leadership/team pages) → web search for "<company> (R&D OR
//           technical director OR …) site:linkedin.com/in" + a general leadership query, with the
//           search provider tried PRIMARY→fallback: Serper.dev (real Google) → free DuckDuckGo →
//           Firecrawl search → askClaude picks the highest-tier person from the REAL result snippets
//           (snippet text ONLY, never invented). PDL person search upgrades a weak/empty result.
//   EMAIL (only a real "@", verified where possible; NEVER a boolean/placeholder/guess-unverified):
//           Hunter (verified) → Prospeo finder (verified) → Tomba finder (free, verified) → PDL work
//           email IF a real "@" → published address on the company site → guess common patterns.
//           VERIFY-BEFORE-TRUST: the finder hits are provider-checked, but the scraped website inbox
//           and any pattern-guess are run through Reoon/Tomba deliverability first — kept only if
//           deliverable, DROPPED on an undeliverable verdict, left unverified (rolls to next run) only
//           when no checker could answer. No real address → email_status "none". We NEVER fabricate.
//
// HONEST LIMIT: finding the right PERSON + LinkedIn is free and reliable; a VERIFIED PERSONAL
// EMAIL at scale needs a paid finder (Hunter/ContactOut). So expect most rows to get a person +
// LinkedIn, a subset to also get a verified email, and the rest "LinkedIn ready — email needs a
// paid finder / manual ContactOut".
//
// WRITES the right-person onto BOTH:
//   - research_targets.json[t]: person_name, person_title, person_linkedin, person_role_tier (A/B/C),
//     person_match_reason, person_email, person_email_status, person_source, person_checked_at.
//   - outreach.json[id].contact: { name, title, linkedin_url, email, email_status, source,
//     confidence, role_tier, match_reason } — so the Outreach compose panel auto-uses this person
//     (name in the greeting, email in To). The UI's manual localStorage contact still wins over this.
//
// Scope: research_targets first (the curated hunt list), then leads already in the outreach pipeline,
// then broader leads. Capped by MAX (default 30). Graceful: needs BEDROCK_API_KEY or PDL_API_KEY for
// person selection — without both it writes nothing and exits 0. Never throws.
//
// Keys: HUNTER_API_KEY, PROSPEO_API_KEY, PDL_API_KEY, REOON_API_KEY, TOMBA_API_KEY + TOMBA_SECRET.
// Test hooks: KGR_OUTREACH_PATH / KGR_LEADS_PATH / KGR_RESEARCH_PATH, and KGR_FAKE_SEARCH /
// KGR_FAKE_PICK / KGR_FAKE_EMAIL / KGR_FAKE_TOMBA_FIND / KGR_FAKE_WEBSITE / KGR_FAKE_VERIFY /
// KGR_FAKE_PROSPEO for offline logic tests (see scripts/… tests).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { firecrawlScrape, firecrawlSearch, freeSearch, freeFetchText, scrapedoGet, apiKey as firecrawlKey, haveScrapedo } from './lib/firecrawl.mjs';
import { serperSearch, haveSerper } from './lib/serper.mjs';
import { askClaude, haveBedrock } from './lib/llm.mjs';

const p = (env, rel) => process.env[env] || fileURLToPath(new URL(rel, import.meta.url));
const LEADS_PATH = p('KGR_LEADS_PATH', '../public/data/leads.json');
const OUTREACH_PATH = p('KGR_OUTREACH_PATH', '../public/data/outreach.json');
const RESEARCH_PATH = p('KGR_RESEARCH_PATH', '../public/data/research_targets.json');

const MAX = Math.max(1, parseInt(process.env.MAX || '30', 10) || 30);
// Budget for the email-upgrade pass (rows that already have a person but no personal email yet).
// Keeps us inside the free monthly finder credits (Hunter 50 + Prospeo 75); the rest roll to next run.
const EMAIL_MAX = Math.max(0, parseInt(process.env.EMAIL_MAX || '40', 10) || 40);
const PRIORITY_ONLY = /^(1|true|yes)$/i.test(process.env.PRIORITY_ONLY || '');
const HUNTER = process.env.HUNTER_API_KEY || '';
const PDL = process.env.PDL_API_KEY || '';
const PROSPEO = process.env.PROSPEO_API_KEY || '';   // email finder (LinkedIn URL / name+domain → verified email)
const REOON = process.env.REOON_API_KEY || '';       // email verifier (funded — guesses + deliverability safety pass)
const TOMBA_KEY = process.env.TOMBA_API_KEY || '';   // Tomba email finder + verifier (free tier)
const TOMBA_SECRET = process.env.TOMBA_SECRET || ''; // paired secret — both headers required
const haveTomba = () => !!(TOMBA_KEY && TOMBA_SECRET);
// Non-negative int from env, honoring an explicit 0 (a plain `|| default` would swallow 0).
const intEnv = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
// Per-run caps to stay inside Tomba's free monthly credits (~25 finds + ~50 verifies).
const TOMBA_CAP = intEnv(process.env.TOMBA_CAP, 20);
// Deliverability safety-check budget/run (Reoon + Tomba verifier combined). Callers process tier-A rows
// first, so the budget is spent on the best rows; the rest roll to next week's run.
const VERIFY_MAX = intEnv(process.env.VERIFY_MAX, 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const domainOf = (l) => { try { return l && l.website ? new URL(String(l.website).startsWith('http') ? l.website : 'https://' + l.website).hostname.replace(/^www\./, '') : ''; } catch { return ''; } };
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// A usable email is a STRING containing "@". PDL's free tier returns a boolean flag ("exists but
// hidden") for emails — those must NEVER be stored as the address or marked verified.
const realEmail = (e) => (typeof e === 'string' && e.includes('@')) ? e.trim() : null;
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter((w) => /[a-z]/i.test(w));
  return parts.length >= 2 ? { first: parts[0], last: parts[parts.length - 1] } : null;
}
// Generic/role inboxes (info@, sales@ …) are real & usable but NOT a person — labelled, never "verified".
const GENERIC_INBOX = new Set(['info', 'sales', 'contact', 'support', 'service', 'admin', 'hello', 'enquiries', 'enquiry', 'dealers', 'orders', 'marketing', 'pr', 'help', 'team', 'office', 'mail', 'careers', 'general']);
function isCompanyInbox(email) {
  const lp = String(email || '').toLowerCase().split('@')[0] || '';
  if (!lp) return false;
  const base = lp.replace(/[._+-].*$/, '').replace(/\d+$/, '');
  return GENERIC_INBOX.has(lp) || GENERIC_INBOX.has(base);
}
// Strip HTML to readable text (keeps <title> + meta description), for the free website-first path.
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, ' $1 ')
    .replace(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}
const asUrl = (v) => { const s = String(v || '').trim(); if (!s) return ''; return s.startsWith('http') ? s : 'https://' + s; };
// Circuit breakers — the paid boosters run out of credits (402); once dead, stop hammering them.
let fcDead = false, pdlDead = false, fcScrapeDead = false, serperDead = false;
// Email step: Tomba finder/verifier + Reoon + Hunter + Prospeo breakers, per-run counters. Disabled on 401/402/403/429.
let tombaFindCalls = 0, tombaFindDead = false, tombaVerifyDead = false, reoonDead = false, verifyCalls = 0;
let hunterDead = false, prospeoDead = false;
const finderTrip = (s) => s === 429 || s === 401 || s === 402 || s === 403; // spent/blocked free tier → disable for the run
// One fetch with a 429 backoff: honor Retry-After (capped), retry a couple of times, then return the 429 so
// the caller can trip its breaker. Stops us bursting free-tier rate limits into a wall of 429s.
const RETRY_CAP_MS = 8000;
async function backoffFetch(url, opts, label, tries = 2) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), ...opts });
    if (res.status !== 429 || i >= tries) return res;
    const ra = parseInt(res.headers.get('retry-after') || '', 10);
    const waitMs = Math.min(Number.isFinite(ra) ? ra * 1000 : 1000 * (i + 1), RETRY_CAP_MS);
    console.error(`[find-contacts] ${label} 429 — backing off ${waitMs}ms (retry ${i + 1}/${tries})`);
    await sleep(waitMs);
  }
}

/* ---------------- Role tiers (the heart of this brick) ---------------- */
// Ordered keyword → human label. First match wins within a tier.
const TIER_A = [['research and development', 'R&D'], ['research & development', 'R&D'], ['r&d', 'R&D'], ['r & d', 'R&D'], ['chief technology', 'Chief Technology'], ['cto', 'CTO'], ['product development', 'Product Development'], ['new product development', 'Product Development'], ['technology', 'Technology'], ['technical', 'Technical'], ['engineering', 'Engineering'], ['innovation', 'Innovation']];
const TIER_B = [['operations', 'Operations'], ['plant manager', 'Plant Manager'], ['manufacturing', 'Manufacturing'], ['production', 'Production']];
const TIER_C = [['purchasing', 'Purchasing'], ['procurement', 'Procurement'], ['sourcing', 'Sourcing'], ['supply chain', 'Supply Chain'], ['buyer', 'Buyer']];
const TIER_RANK = { A: 3, B: 2, C: 1 };
// Classify a job title → { tier:'A'|'B'|'C'|null, reason:'<matched keyword>' }. Deterministic; the LLM
// only selects the person, this decides the tier from the real title.
function roleTier(title) {
  const t = ' ' + String(title || '').toLowerCase().replace(/&/g, ' & ').replace(/[^a-z& ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  const has = (kw) => t.includes(' ' + kw + ' ');   // whole-token match (so "cto" ≠ "director")
  const isSales = /\b(sales|marketing|business development|commercial|account)\b/.test(t);
  const isIT = /information technology|\bit\b|software|cyber|digital|data /.test(t);
  for (const [kw, label] of TIER_A) {
    if (!has(kw)) continue;
    if (kw === 'technology' && isIT) continue;                       // IT ≠ R&D
    if ((kw === 'technical' || kw === 'technology') && isSales) continue; // "technical sales" ≠ decision-maker
    return { tier: 'A', reason: label };
  }
  for (const [kw, label] of TIER_B) if (has(kw)) return { tier: 'B', reason: label };
  for (const [kw, label] of TIER_C) if (has(kw)) return { tier: 'C', reason: label };
  return { tier: null, reason: '' };
}
const PERSON_QUERY = (company) => `"${company}" (R&D OR "research and development" OR "technical director" OR "head of technology" OR "technology manager" OR "R&D manager" OR "product development" OR "operations manager" OR "operations director" OR "head of operations") site:linkedin.com/in`;
// A general leadership/team query (no site: restriction) — catches company leadership pages, press
// and profiles the linkedin.com/in query misses. Used as a second Serper query when the first is thin.
const LEADERSHIP_QUERY = (company) => `"${company}" (leadership OR "management team" OR "our team" OR "R&D" OR "technical director" OR "head of technology" OR "operations director")`;

/* ---------------- Data IO ---------------- */
async function loadJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }
async function loadLeads() {
  const raw = await loadJson(LEADS_PATH, []);
  return Array.isArray(raw) ? raw : (raw.leads || []);
}

/* ---------------- Person finders ---------------- */
// Gather REAL result snippets for the tiered query. Search provider order:
//   Serper.dev (real Google, PRIMARY) → free DuckDuckGo (fallback) → Firecrawl search (booster).
// `lastSearchVia` records which provider actually produced the rows, for an honest person_source.
let fcNullStreak = 0, serperNullStreak = 0, lastSearchVia = 'web';
async function personSnippets(company, debug) {
  const rows = [];
  const asRow = (r) => ({ title: r.title || '', url: r.url || r.link || '', description: r.description || r.snippet || '' });
  const add = (arr) => { for (const r of (arr || [])) { const m = asRow(r); if (m.url) rows.push(m); } };
  let usedSerper = false, usedDDG = false, usedFC = false;

  // 1) Serper.dev (PRIMARY). LinkedIn/in decision-maker query first; add a general leadership query if thin.
  if (haveSerper() && !serperDead) {
    const r1 = await serperSearch(PERSON_QUERY(company), debug);
    if (r1 === null) {
      if (++serperNullStreak >= 2) { serperDead = true; console.log('[find-contacts] Serper unavailable (key/credits?) — disabling for this run.'); }
    } else {
      serperNullStreak = 0;
      if (r1.length) { add(r1); usedSerper = true; }
    }
    if (!serperDead && rows.length < 3) {
      const r2 = await serperSearch(LEADERSHIP_QUERY(company), debug);
      if (Array.isArray(r2) && r2.length) { add(r2); usedSerper = true; }
    }
  }
  // 2) FREE DuckDuckGo (fallback — often bot-walled on CI, so no longer primary).
  if (rows.length < 3) {
    let ddg = []; try { ddg = await freeSearch(PERSON_QUERY(company)); } catch { ddg = []; }
    if (ddg && ddg.length) { add(ddg); usedDDG = true; }
  }
  // 3) Firecrawl search (booster; only while its key still has credits).
  if (rows.length < 3 && firecrawlKey() && !fcDead) {
    const fc = await firecrawlSearch(PERSON_QUERY(company), debug);
    if (Array.isArray(fc) && fc.length) { add(fc); usedFC = true; fcNullStreak = 0; }
    else if (++fcNullStreak >= 2) { fcDead = true; console.log('[find-contacts] Firecrawl search unavailable (credits?) — disabling for this run.'); }
  }
  lastSearchVia = usedSerper ? 'serper' : usedDDG ? 'web' : usedFC ? 'firecrawl' : 'web';
  // de-dupe by url, keep only real result rows
  const seen = new Set(); const out = [];
  for (const r of rows) { if (!r.url || seen.has(r.url)) continue; seen.add(r.url); out.push(r); }
  return out.slice(0, 12);
}

// Fake-search hook for offline logic tests (KGR_FAKE_SEARCH = JSON array of {title,url,description}).
function fakeSnippets(company) {
  try { const all = JSON.parse(process.env.KGR_FAKE_SEARCH || '{}'); return all[company] || all['*'] || null; } catch { return null; }
}

// Pick the highest-tier person from real snippets. Uses ONLY snippet text; returns {name,title,linkedin_url} or null.
async function pickFromSnippets(company, snippets) {
  if (process.env.KGR_FAKE_PICK) { try { const m = JSON.parse(process.env.KGR_FAKE_PICK); return m[company] || m['*'] || null; } catch { /* ignore */ } }
  if (!snippets.length || !haveBedrock()) {
    // No LLM: a light, honest fallback — take the first linkedin/in result and parse "Name - Title"
    const li = snippets.find((s) => /linkedin\.com\/in\//i.test(s.url));
    if (!li) return null;
    const m = String(li.title || '').split(/\s[-–|]\s/);
    const name = (m[0] || '').replace(/\s*\|\s*linkedin.*$/i, '').trim();
    const title = (m[1] || '').replace(/\s*\|\s*linkedin.*$/i, '').trim();
    return name ? { name, title, linkedin_url: li.url.split('?')[0] } : null;
  }
  const text = snippets.map((r) => `${r.title} | ${r.url} | ${r.description}`).join('\n').slice(0, 4000);
  const pick = await askClaude({
    system: 'From REAL LinkedIn/web search snippets, pick the ONE person who is the most senior TECHNICAL / R&D / OPERATIONS decision-maker at the target company. Prefer, best→worst: R&D / Technology / Technical / Product Development / Engineering leaders; then Operations leaders; ONLY if none of those appear, a Purchasing/Procurement lead. Avoid pure Sales, Marketing, HR and Finance people. Use ONLY the snippet text — never invent a name, title or URL. Return STRICT JSON {"name","title","linkedin_url"} or {} if no suitable person is present.',
    user: `Company: ${company}\nSnippets:\n${text}`,
    json: true, maxTokens: 300,
  });
  if (pick && pick.name) return { name: String(pick.name).trim(), title: String(pick.title || '').trim(), linkedin_url: pick.linkedin_url ? String(pick.linkedin_url).split('?')[0] : null };
  return null;
}

// PDL person search (accuracy booster) — returns the highest-tier person at the company, or null.
async function pdlPerson(company) {
  if (!PDL || pdlDead) return null;
  try {
    const res = await fetch('https://api.peopledatalabs.com/v5/person/search', {
      method: 'POST',
      headers: { 'X-Api-Key': PDL, 'content-type': 'application/json' },
      body: JSON.stringify({ query: { bool: { must: [{ match: { job_company_name: company } }] } }, size: 10 }),
      signal: AbortSignal.timeout(30_000),
    });
    if ([402, 403, 429].includes(res.status)) { pdlDead = true; console.log(`[find-contacts] PDL unavailable (${res.status}) — disabling for this run.`); return null; }
    if (!res.ok) { console.error(`[find-contacts] PDL ${res.status}`); return null; }
    const data = await res.json();
    const people = (data && data.data) || [];
    let best = null, bestRank = -1;
    for (const r of people) {
      const title = r.job_title || '';
      const { tier } = roleTier(title);
      const rank = tier ? TIER_RANK[tier] : 0;
      if (rank > bestRank) {
        const name = r.full_name || [r.first_name, r.last_name].filter(Boolean).join(' ');
        if (!name) continue;
        const li = r.linkedin_url ? (String(r.linkedin_url).startsWith('http') ? r.linkedin_url : 'https://' + r.linkedin_url) : null;
        const emailRaw = r.work_email || (Array.isArray(r.emails) && r.emails[0] && (r.emails[0].address || r.emails[0])) || null;
        best = { name, title, linkedin_url: li, email: realEmail(emailRaw) }; bestRank = rank;
      }
    }
    return best;
  } catch (e) { console.error(`[find-contacts] PDL failed (ok): ${e.message}`); return null; }
}

// FREE website-first person: read the company's own leadership / team / about pages (no search
// credits) and let Bedrock extract the most senior technical/ops person NAMED in the text. Mirrors
// verify-research-targets.mjs. Source-backed — uses only names/titles on the page, never invented.
async function websitePerson(company, website, debug) {
  if (!haveBedrock()) return null;
  const base = asUrl(website).replace(/\/$/, ''); if (!base) return null;
  let origin; try { origin = new URL(base).origin; } catch { return null; }
  const paths = ['/leadership', '/leadership-team', '/our-team', '/team', '/management', '/about/leadership', '/about-us', '/about', '/company', '/who-we-are', '/our-company', ''];
  const EXECISH = /chief|officer|\bvp\b|vice president|president|director|head of|manager|leadership|management|founder/i;
  let text = '';
  // 1) FREE fetch (no cost) first.
  for (const pth of paths) {
    const html = await freeFetchText(origin + pth);
    if (!html) continue;
    const t = htmlToText(html);
    if (EXECISH.test(t)) { text += ' ' + t; if (debug) debug.push({ reader: 'website-people', url: origin + pth, len: t.length }); }
    if (text.length > 9000) break;
  }
  // 2) If free reading was thin (JS-rendered / consent-walled site), use Firecrawl SCRAPE (renders JS)
  //    on the two most likely pages. Bounded + circuit-broken so a capped plan doesn't get hammered.
  if (text.length < 500 && firecrawlKey() && !fcScrapeDead) {
    for (const pth of ['/leadership', '/about', '']) {
      const d = await firecrawlScrape(origin + pth, { formats: ['markdown'] }, debug);
      if (d && d.markdown) { if (EXECISH.test(d.markdown)) { text += ' ' + d.markdown; if (debug) debug.push({ reader: 'firecrawl-people', url: origin + pth }); } }
      else { fcScrapeDead = true; console.log('[find-contacts] Firecrawl scrape unavailable (credits?) — disabling for this run.'); break; }
      if (text.length > 6000) break;
    }
  }
  text = text.slice(0, 9000).trim();
  if (!text) return null;
  const pick = await askClaude({
    system: 'From the company website text, identify the SINGLE most senior TECHNICAL / R&D / OPERATIONS decision-maker who is NAMED in the text. Prefer, best→worst: R&D / Technology / Technical / Product Development / Engineering leaders; then Operations / Manufacturing / Plant leaders; then, only if no such person is named, any senior executive (e.g. CEO/President). Ignore pure Sales, Marketing, HR and Finance people when a technical/ops person is named. Use ONLY names and titles present in the text — never invent. Return STRICT JSON {"name","title"} or {} if no person is named.',
    user: `Company: ${company}\nWebsite: ${origin}\n\nWEBSITE TEXT (the only source you may use):\n${text}`,
    json: true, maxTokens: 250,
  });
  if (pick && pick.name && String(pick.name).trim()) return { name: String(pick.name).trim(), title: String(pick.title || '').trim(), linkedin_url: null };
  return null;
}

// Find the best right-person for a company, keeping the HIGHEST tier across sources.
// Order (cost-aware): FREE website-first → free web search + Firecrawl booster → PDL booster.
// Returns { name,title,linkedin_url,tier,reason,source,pdlEmail } or null.
async function findPerson(company, website, debug) {
  let best = null, bestTier = { tier: null }, source = '', pdlEmail = null;
  const rankOf = (tierObj) => (tierObj.tier ? TIER_RANK[tierObj.tier] : 0.5);
  const consider = (cand, tierObj, src) => {
    if (!cand || !cand.name) return;
    const cur = best ? rankOf(bestTier) : -1;
    const r = rankOf(tierObj);
    if (r > cur || (r === cur && best && !best.linkedin_url && cand.linkedin_url)) { best = cand; bestTier = tierObj; source = src; }
  };
  const haveAB = () => best && (bestTier.tier === 'A' || bestTier.tier === 'B');

  // 0) FREE website-first (no search credits).
  if (website && haveBedrock()) { const wp = await websitePerson(company, website, debug); if (wp) consider(wp, roleTier(wp.title), 'website'); }
  // 1) web search (Serper PRIMARY → DDG → Firecrawl) → LLM picks the highest-tier person from real
  //    snippets. Also runs when we already have an A/B person but no LinkedIn yet, to attach a
  //    source-backed profile URL.
  if (!haveAB() || (best && !best.linkedin_url)) {
    const fake = fakeSnippets(company);
    const snippets = fake || await personSnippets(company, debug);
    const via = fake ? 'web' : lastSearchVia;
    const web = await pickFromSnippets(company, snippets);
    if (web) consider(web, roleTier(web.title), via);
  }
  // 2) PDL booster (accuracy) — only to upgrade a weak/empty result.
  if (PDL && !pdlDead && !haveAB()) {
    const pdl = await pdlPerson(company);
    if (pdl) { const before = best; consider({ name: pdl.name, title: pdl.title, linkedin_url: pdl.linkedin_url }, roleTier(pdl.title), 'pdl'); if (best !== before && source === 'pdl') pdlEmail = pdl.email; }
  }
  if (!best) return null;
  return { ...best, tier: bestTier.tier, reason: bestTier.reason, source, pdlEmail };
}

/* ---------------- Email finders (real, verified where possible) ---------------- */
// Hunter EMAIL FINDER — a precise personal email for a KNOWN person (name + domain). Tried before the
// broader domain-search so we prefer the individual's address over any generic inbox. Returns an "@" or null.
async function hunterFindEmail(name, domain) {
  if (!HUNTER || hunterDead) return null;
  const n = splitName(name); if (!n || !domain) return null;
  try {
    const res = await backoffFetch(`https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(n.first)}&last_name=${encodeURIComponent(n.last)}&api_key=${encodeURIComponent(HUNTER)}`, {}, 'Hunter finder');
    if (!res.ok) { if (finderTrip(res.status)) hunterDead = true; console.error(`[find-contacts] Hunter finder ${res.status}`); return null; }
    const data = await res.json();
    return realEmail(data && data.data && data.data.email);
  } catch (e) { console.error(`[find-contacts] Hunter finder failed (ok): ${e.message}`); return null; }
}
async function hunterEmail(role, domain) {
  if (!HUNTER || hunterDead) return null;
  try {
    const res = await backoffFetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(HUNTER)}`, {}, 'Hunter');
    if (!res.ok) { if (finderTrip(res.status)) hunterDead = true; console.error(`[find-contacts] Hunter ${res.status}`); return null; }
    const data = await res.json();
    const emails = (data && data.data && data.data.emails) || [];
    if (!emails.length) return null;
    // Prefer a technical/ops person's address over a generic inbox.
    const ranked = emails.map((e) => ({ e, rank: TIER_RANK[roleTier(e.position || '').tier] || 0 })).sort((a, b) => b.rank - a.rank);
    const v = ranked.find((x) => x.e.verification && x.e.verification.status === 'valid') || ranked[0];
    return v ? { email: v.e.value, name: [v.e.first_name, v.e.last_name].filter(Boolean).join(' '), title: v.e.position || '' } : null;
  } catch (e) { console.error(`[find-contacts] Hunter failed (ok): ${e.message}`); return null; }
}
let prospeoCalls = 0; const PROSPEO_CAP = 45;
// Prospeo enrich-person is the CURRENT endpoint. The old social-url-enrichment + email-finder were
// deprecated and REMOVED (~Mar 2026) — calling them 400s. enrich-person takes a `data` object with any
// of { first_name, last_name, company_name, company_website, linkedin_url } and returns a verified email
// at person.email.email. X-KEY auth, PROSPEO_CAP budget, breaker on a spent/blocked free tier.
async function prospeoPost(path, body) {
  if (!PROSPEO || prospeoDead || prospeoCalls >= PROSPEO_CAP) return null;
  if (process.env.KGR_FAKE_PROSPEO) { prospeoCalls++; try { const m = JSON.parse(process.env.KGR_FAKE_PROSPEO); const k = (body && body.data && (body.data.linkedin_url || body.data.company_website)) || '*'; return m[k] || m['*'] || null; } catch { return null; } }
  prospeoCalls++; await sleep(900);                                             // gentle spacing between calls
  try {
    const res = await backoffFetch(`https://api.prospeo.io/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-KEY': PROSPEO }, body: JSON.stringify(body) }, `Prospeo ${path}`);
    if (!res.ok) { if (finderTrip(res.status)) prospeoDead = true; console.error(`[find-contacts] Prospeo ${path} ${res.status}`); return null; }
    const data = await res.json();
    return (data && data.error) ? null : data;
  } catch (e) { console.error(`[find-contacts] Prospeo ${path} failed (ok): ${e.message}`); return null; }
}
// enrich-person → person.email.email. Keep ONLY a REVEALED, real, NON-MASKED "@": the free tier can return a
// masked address like "a*****@x.com" — that is not a usable email and must NEVER be stored (would be fabrication).
async function prospeoEnrich(data) {
  const d = await prospeoPost('enrich-person', { data });
  const e = d && d.person && d.person.email;
  if (!e || e.revealed === false) return null;
  const email = realEmail(e.email);
  return (email && !email.includes('*')) ? email : null;
}
const prospeoFromLinkedin = (url, domain) => (url ? prospeoEnrich({ linkedin_url: url, ...(domain ? { company_website: domain } : {}) }) : Promise.resolve(null));
async function prospeoFromName(name, domain) { const n = splitName(name); return (n && domain) ? prospeoEnrich({ first_name: n.first, last_name: n.last, company_website: domain }) : null; }

/* ---- Tomba (free finder + verifier) — auth via X-Tomba-Key + X-Tomba-Secret headers ---- */
const tombaHeaders = () => ({ 'X-Tomba-Key': TOMBA_KEY, 'X-Tomba-Secret': TOMBA_SECRET, accept: 'application/json' });
const tombaTrip = (status) => status === 401 || status === 402 || status === 429; // auth / out-of-credit / rate-limited
// Tomba's docs use query-param endpoints (?domain= / ?email=); its SDKs use a /{path} segment. The two differ
// and a wrong shape returns 404, so we try the documented query form first, fall back to the path form on a
// 404, and cache whichever the API accepts for the rest of the run.
let tombaFindForm = 0, tombaVerifyForm = 0;
const tombaFindUrls = (domain, n) => { const qs = `first_name=${encodeURIComponent(n.first)}&last_name=${encodeURIComponent(n.last)}`; return [`https://api.tomba.io/v1/email-finder?domain=${encodeURIComponent(domain)}&${qs}`, `https://api.tomba.io/v1/email-finder/${encodeURIComponent(domain)}?${qs}`]; };
const tombaVerifyUrls = (email) => [`https://api.tomba.io/v1/email-verifier?email=${encodeURIComponent(email)}`, `https://api.tomba.io/v1/email-verifier/${encodeURIComponent(email)}`];
// Try the cached form first, then the other on a 404. Returns { res, form } for the first non-404, or null (both 404).
async function tombaFetch(urls, startForm) {
  for (const f of (startForm === 1 ? [1, 0] : [0, 1])) {
    const res = await backoffFetch(urls[f], { headers: tombaHeaders() }, 'Tomba');
    if (res.status !== 404) return { res, form: f };
  }
  return null;
}
// Tomba EMAIL FINDER — a precise personal email for a KNOWN person.
// Returns a real "@" (only a non-disposable, non-"invalid" hit) or null. Graceful; capped; trips the breaker on 401/402/429.
async function tombaFind(name, domain) {
  if (!haveTomba() || tombaFindDead || tombaFindCalls >= TOMBA_CAP) return null;
  const n = splitName(name); if (!n || !domain) return null;
  if (process.env.KGR_FAKE_TOMBA_FIND) { tombaFindCalls++; try { const m = JSON.parse(process.env.KGR_FAKE_TOMBA_FIND); return realEmail(m[domain] || m[name] || m['*']); } catch { return null; } }
  tombaFindCalls++;
  try {
    const hit = await tombaFetch(tombaFindUrls(domain, n), tombaFindForm);
    if (!hit) { console.error('[find-contacts] Tomba finder 404 (both URL forms) — disabling'); tombaFindDead = true; return null; }
    tombaFindForm = hit.form; const res = hit.res;
    if (!res.ok) { if (tombaTrip(res.status)) tombaFindDead = true; console.error(`[find-contacts] Tomba finder ${res.status}`); return null; }
    const d = ((await res.json()) || {}).data || {};
    const email = realEmail(d.email); if (!email) return null;
    if (d.disposable === true) return null;                                        // never store a disposable address
    if (String((d.verification && d.verification.status) || '').toLowerCase() === 'invalid') return null;
    return email;
  } catch (e) { console.error(`[find-contacts] Tomba finder failed (ok): ${e.message}`); return null; }
}
// Tomba EMAIL VERIFIER — deliverability of ANY address.
// 'good' (deliverable) | 'bad' (undeliverable) | null (inconclusive / couldn't check).
async function tombaVerify(email) {
  if (!haveTomba() || tombaVerifyDead || !realEmail(email)) return null;
  try {
    const hit = await tombaFetch(tombaVerifyUrls(email), tombaVerifyForm);
    if (!hit) { tombaVerifyDead = true; return null; }
    tombaVerifyForm = hit.form; const res = hit.res;
    if (!res.ok) { if (tombaTrip(res.status)) tombaVerifyDead = true; return null; }
    const e = (((await res.json()) || {}).data || {}).email || {};
    const result = String(e.result || '').toLowerCase(); const status = String(e.status || '').toLowerCase();
    if (result === 'deliverable' || status === 'valid') return 'good';
    if (result === 'undeliverable' || status === 'invalid' || e.disposable === true) return 'bad';
    return null;                                                                   // risky / accept_all / webmail / unknown → inconclusive
  } catch { return null; }
}

// Reoon verdict for an address: 'good' (safe) | 'bad' (definitely undeliverable) | null (inconclusive / couldn't check).
async function reoonVerdict(email) {
  if (!REOON || reoonDead || !realEmail(email)) return null;
  try {
    const res = await fetch(`https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(REOON)}&mode=power`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) { if (res.status === 401 || res.status === 402 || res.status === 429) reoonDead = true; return null; }
    const st = String((((await res.json()) || {}).status) || '').toLowerCase();
    if (st === 'safe') return 'good';
    if (st === 'invalid' || st === 'disposable' || st === 'spamtrap') return 'bad';
    return null;                                          // catch_all / unknown / role_account → inconclusive (don't drop a real address on this)
  } catch { return null; }
}
// Deliverability safety check for an address we did NOT get from a finder (a scraped website inbox, or a guess).
// Reoon (funded) first, then the Tomba verifier. Budget-capped per run (VERIFY_MAX); the callers process
// tier-A rows first, so the budget lands on the best rows. Returns:
//   true  → confirmed deliverable (trust it)
//   false → a checker says undeliverable (DROP it — never store a risky address)
//   null  → couldn't check (no key / budget spent / all inconclusive) → keep as-is, roll to next run; NEVER drop on our own outage.
async function verifyDeliverable(email) {
  if (!realEmail(email)) return false;
  if (process.env.KGR_FAKE_VERIFY) {
    if (verifyCalls >= VERIFY_MAX) return null;
    verifyCalls++;
    try { const v = (JSON.parse(process.env.KGR_FAKE_VERIFY)[email]) ?? JSON.parse(process.env.KGR_FAKE_VERIFY)['*'];
      if (v === 'good' || v === true) return true; if (v === 'bad' || v === false) return false; return null; } catch { return null; }
  }
  if (REOON && !reoonDead && verifyCalls < VERIFY_MAX) {
    verifyCalls++;
    const v = await reoonVerdict(email); if (v === 'good') return true; if (v === 'bad') return false;
  }
  if (haveTomba() && !tombaVerifyDead && verifyCalls < VERIFY_MAX) {
    verifyCalls++;
    const v = await tombaVerify(email); if (v === 'good') return true; if (v === 'bad') return false;
  }
  return null;
}
function emailPatterns(name, domain) {
  const n = splitName(name); if (!n || !domain) return [];
  const f = n.first.toLowerCase().replace(/[^a-z]/g, ''); const l = n.last.toLowerCase().replace(/[^a-z]/g, '');
  if (!f || !l) return [];
  return [`${f}.${l}@${domain}`, `${f[0]}${l}@${domain}`, `${f}@${domain}`, `${f[0]}.${l}@${domain}`, `${f}${l}@${domain}`];
}
async function guessAndVerify(name, domain) {
  // A SYNTHESIZED address — keep ONLY on a POSITIVE deliverability verdict (Reoon/Tomba), never on an
  // inconclusive one. When no checker is available it yields nothing, so we never store an unverified guess.
  for (const e of emailPatterns(name, domain)) if ((await verifyDeliverable(e)) === true) return e;
  return null;
}
// Published address on the company website — free fetch first, Scrape.do, then Firecrawl.
async function websiteEmail(website, debug) {
  const base = String(website).replace(/\/$/, '');
  if (process.env.KGR_FAKE_WEBSITE) { try { const d = new URL(base).hostname.replace(/^www\./, ''); return JSON.parse(process.env.KGR_FAKE_WEBSITE)[d] || null; } catch { return null; } }
  let text = '';
  for (const u of [`${base}/contact`, `${base}/about`, base]) {
    const html = await freeFetchText(u);
    if (html) { text += ' ' + html; if (text.length > 6000) break; }
  }
  if (!text && haveScrapedo()) { const html = await scrapedoGet(base); if (html) text += html.slice(0, 6000); }
  if (!text && firecrawlKey()) { const d = await firecrawlScrape(base, { formats: ['markdown'] }, debug); if (d && d.markdown) text += d.markdown; }
  const m = text.match(EMAIL_RE);
  if (m && !/example\.|sentry|wixpress|\.png|\.jpg|\.gif|@sentry/i.test(m[0])) return m[0];
  return null;
}

// Offline test hook (mirrors KGR_FAKE_SEARCH/PICK): KGR_FAKE_EMAIL = JSON map keyed by domain or
// person name (or '*') → { email, email_status?, via? }. Returns undefined when unset (real path runs).
function fakeEmail(person, domain) {
  if (!process.env.KGR_FAKE_EMAIL) return undefined;
  try {
    const m = JSON.parse(process.env.KGR_FAKE_EMAIL);
    const hit = m[domain] || m[(person && person.name) || ''] || m['*'];
    if (!hit || !hit.email) return { email: null, email_status: 'none', via: 'fake' };
    return { email: hit.email, email_status: hit.email_status || (isCompanyInbox(hit.email) ? 'published' : 'verified'), via: hit.via || 'fake' };
  } catch { return undefined; }
}

// Find the best real email for a chosen person. Returns { email, email_status, via, email_verified, email_checked_at }.
//   email_status ∈ verified|published|none · email_verified=true means a finder/verifier vouched for it today.
// Finder hits (Hunter/Prospeo/Tomba/PDL) are already deliverability-checked by the provider, so they are
// trusted as-is; the scraped website address and any guess go through verifyDeliverable() before we keep them.
async function findEmail(person, domain, debug) {
  const fk = fakeEmail(person, domain); if (fk !== undefined) return fk;
  if (!domain) return { email: null, email_status: 'none', via: '' };
  const nowISO = new Date().toISOString().slice(0, 10);
  const finderHit = (email, via) => ({ email, email_status: isCompanyInbox(email) ? 'published' : 'verified', via, email_verified: true, email_checked_at: nowISO });
  // 1a) Hunter EMAIL FINDER (precise personal email for the known person) — try first when we have a name.
  if (HUNTER && person.name) { const hf = await hunterFindEmail(person.name, domain); if (hf) return finderHit(hf, 'hunter-finder'); }
  // 1b) Hunter domain-search (verified) — pick the best-ranked person/inbox on the domain.
  if (HUNTER) { const h = await hunterEmail(person.title, domain); const he = realEmail(h && h.email); if (he) return finderHit(he, 'hunter'); }
  // 2) Prospeo (verified) — LinkedIn URL, else name + domain
  if (PROSPEO) { const pp = (await prospeoFromLinkedin(person.linkedin_url, domain)) || (person.name ? await prospeoFromName(person.name, domain) : null); if (pp) return finderHit(pp, 'prospeo'); }
  // 2b) Tomba EMAIL FINDER (free) — a precise personal email; before PDL/website/guess (free-first).
  if (haveTomba() && person.name) { const tf = await tombaFind(person.name, domain); if (tf) return finderHit(tf, 'tomba'); }
  // 3) PDL work email (only a real "@")
  const pe = realEmail(person.pdlEmail); if (pe) return finderHit(pe, 'pdl');
  // 4) Published website address — VERIFY deliverability before we trust it (never keep an inbox that may not exist).
  if (domain) {
    const pub = realEmail(await websiteEmail('https://' + domain, debug));
    if (pub) {
      const verdict = await verifyDeliverable(pub);                 // true | false | null
      if (verdict === false) { console.error(`[find-contacts] dropped risky website email ${pub} @ ${domain} (verifier: undeliverable)`); }
      else return { email: pub, email_status: 'published', via: verdict === true ? 'website+verified' : 'website', email_verified: verdict === true, email_checked_at: verdict === null ? null : nowISO };
    }
  }
  // 5) Guess a pattern, keep ONLY on a positive deliverability verdict (never fabricate).
  if (person.name) { const g = await guessAndVerify(person.name, domain); if (g) return { email: g, email_status: isCompanyInbox(g) ? 'published' : 'verified', via: 'guess', email_verified: true, email_checked_at: nowISO }; }
  return { email: null, email_status: 'none', via: '' };
}

/* ---------------- Main ---------------- */
async function main() {
  // Person discovery needs a selector (Bedrock/PDL). The email-upgrade pass does NOT — it only needs
  // email providers — so we no longer exit early; we skip the primary pass and still run the upgrade.
  const canFindPeople = haveBedrock() || !!PDL;
  if (!canFindPeople) console.log('[find-contacts] no BEDROCK_API_KEY/PDL_API_KEY — skipping person discovery; email-upgrade pass only.');
  console.log(`[find-contacts] search: serper=${haveSerper() ? 'yes' : 'no'} (primary) ddg=free firecrawl=${firecrawlKey() ? 'yes' : 'no'} | readers: free=yes scrapedo=${haveScrapedo() ? 'yes' : 'no'} | person: bedrock=${haveBedrock() ? 'yes' : 'no'} pdl=${PDL ? 'yes' : 'no'} | email: hunter=${HUNTER ? 'yes' : 'no'} prospeo=${PROSPEO ? 'yes' : 'no'} tomba=${haveTomba() ? 'yes' : 'no'} reoon=${REOON ? 'yes' : 'no'} | verify-before-trust: budget=${VERIFY_MAX}/run (tomba-find cap=${TOMBA_CAP})`);

  const leads = await loadLeads();
  const outreach = await loadJson(OUTREACH_PATH, {});
  const researchRaw = await loadJson(RESEARCH_PATH, { targets: [] });
  const targets = Array.isArray(researchRaw) ? researchRaw : (researchRaw.targets || []);
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const outreachContactName = (id) => outreach[id] && outreach[id].contact && outreach[id].contact.name;

  // QUEUE — research targets first (curated hunt list; confirmed/verified first, un-checked first),
  // then leads already in the outreach pipeline, then broader leads. Cap at MAX.
  const tRank = (t) => (t.product_confirmed === true ? 0 : t.verified ? 1 : 2);
  const targetQueue = targets
    .filter((t) => t && t.company && !t.person_name)   // no right-person yet (retries prior blanks)
    .filter((t) => !PRIORITY_ONLY || t.product_confirmed === true)
    .sort((a, b) => tRank(a) - tRank(b) || String(a.company).localeCompare(String(b.company)))
    .map((t) => ({ kind: 'target', id: t.id, company: t.company, website: t.website || (leadById.get(t.id) || {}).website || '', target: t }));

  const targetIds = new Set(targetQueue.map((q) => q.id));
  const lRank = (l) => (outreach[l.id] ? 0 : 2) + (l.priority === 'High' ? 0 : 1);
  const leadQueue = leads
    .filter((l) => l && l.company && !targetIds.has(l.id) && !outreachContactName(l.id))
    .filter((l) => !PRIORITY_ONLY || l.priority === 'High')
    .sort((a, b) => lRank(a) - lRank(b) || String(a.company).localeCompare(String(b.company)))
    .map((l) => ({ kind: 'lead', id: l.id, company: l.company, website: l.website || '', target: null }));

  const queue = canFindPeople ? targetQueue.concat(leadQueue).slice(0, MAX) : [];
  if (canFindPeople) console.log(`[find-contacts] processing ${queue.length} (targets=${Math.min(targetQueue.length, MAX)} of ${targetQueue.length}, then leads)`);

  const debug = [];
  const tally = { people: 0, A: 0, B: 0, C: 0, none: 0, emails: 0 };
  const processedIds = new Set();     // ids the primary pass already handled this run (excluded from the upgrade pass)
  let changedOutreach = false, changedResearch = false;
  try {
    for (const item of queue) {
      processedIds.add(item.id);
      const domain = domainOf(item);
      const person = await findPerson(item.company, item.website, debug);
      const nowISO = new Date().toISOString().slice(0, 10);

      if (item.target) { item.target.person_checked_at = nowISO; changedResearch = true; }

      if (!person || !person.name) { tally.none++; continue; }
      tally.people++;
      if (person.tier) tally[person.tier]++; else tally.none++;

      const em = await findEmail(person, domain, debug);
      if (em.email) tally.emails++;

      const contact = {
        name: person.name,
        title: person.title || '',
        linkedin_url: person.linkedin_url || null,
        email: em.email,
        email_status: em.email_status,
        email_verified: em.email_verified || false,
        email_checked_at: em.email_checked_at || null,
        source: [person.source, em.via].filter(Boolean).join('+') || 'web',
        confidence: person.source === 'pdl' ? 'high' : (person.tier ? 'medium' : 'low'),
        role_tier: person.tier || null,
        match_reason: person.reason || '',
      };
      outreach[item.id] = { ...(outreach[item.id] || {}), contact };
      changedOutreach = true;

      if (item.target) {
        const t = item.target;
        t.person_name = person.name;
        t.person_title = person.title || '';
        t.person_linkedin = person.linkedin_url || null;
        t.person_role_tier = person.tier || null;
        t.person_match_reason = person.reason || '';
        t.person_email = em.email;
        t.person_email_status = em.email_status;
        t.person_email_verified = em.email_verified || false;
        t.person_email_checked_at = em.email_checked_at || null;
        t.person_source = contact.source;
      }
      console.log(`[find-contacts] ${item.company}: ${person.name} · ${person.title || '?'} · tier ${person.tier || '-'} · email ${em.email_status}${em.email ? ' (' + em.via + ')' : ''}`);
    }
  } catch (e) { console.error(`[find-contacts] pipeline error (continuing): ${e.message}`); }

  // ---------------- EMAIL-UPGRADE PASS ----------------
  // Go BACK over rows that ALREADY have a person but no PERSONAL email (missing, or a company inbox)
  // and try ONLY the email finders — NO person discovery. Write only on a strict improvement
  // (personal > company > none); never overwrite a personal email, never downgrade, never invent
  // (guesses stay Reoon-gated). Budget: at most EMAIL_MAX rows per run; the rest roll to next week.
  const isPersonal = (e) => !!realEmail(e) && !isCompanyInbox(e);
  const emRank = (e) => (isPersonal(e) ? 2 : realEmail(e) ? 1 : 0);
  const targetsById = new Map(targets.map((t) => [t.id, t]));
  const candIds = new Set();
  for (const id of Object.keys(outreach)) {
    const c = outreach[id] && outreach[id].contact;
    if (c && c.name && !processedIds.has(id) && !isPersonal(c.email)) candIds.add(id);
  }
  for (const t of targets) {
    if (t && t.person_name && t.id && !processedIds.has(t.id) && !isPersonal(t.person_email)) candIds.add(t.id);
  }
  const upRows = [];
  for (const id of candIds) {
    const c = (outreach[id] && outreach[id].contact) || null;
    const t = targetsById.get(id) || null;
    const name = (c && c.name) || (t && t.person_name) || '';
    if (!name) continue;
    const domain = domainOf({ website: (leadById.get(id) || {}).website || (t && t.website) || '' });
    if (!domain) continue;                                          // no domain → can't find an email
    const person = { name, title: (c && c.title) || (t && t.person_title) || '', linkedin_url: (c && c.linkedin_url) || (t && t.person_linkedin) || null };
    const tier = (c && c.role_tier) || (t && t.person_role_tier) || null;
    const priority = (leadById.get(id) || {}).priority || '';
    upRows.push({ id, person, domain, tier, priority, t, c });
  }
  const tierScore = (x) => (x.tier === 'A' ? 3 : x.tier === 'B' ? 2 : x.tier === 'C' ? 1 : 0);
  upRows.sort((a, b) => tierScore(b) - tierScore(a) || ((b.priority === 'High') - (a.priority === 'High')) || String(a.person.name).localeCompare(String(b.person.name)));
  const upQueue = upRows.slice(0, EMAIL_MAX);
  console.log(`[find-contacts] email-upgrade: ${upRows.length} row(s) have a person but no personal email; processing ${upQueue.length} (EMAIL_MAX=${EMAIL_MAX}) — person-search SKIPPED for these.`);
  const up = { upgraded: 0, verified: 0, published: 0 };
  try {
    for (const row of upQueue) {
      const curEmail = (row.c && row.c.email) || (row.t && row.t.person_email) || null;
      const curRank = emRank(curEmail);
      const em = await findEmail(row.person, row.domain, debug);    // EMAIL ONLY — no person discovery
      if (!em.email || emRank(em.email) <= curRank) continue;       // strict improvement only (never downgrade/overwrite personal)
      const base = (row.c && typeof row.c === 'object') ? row.c
        : { name: row.person.name, title: row.person.title, linkedin_url: row.person.linkedin_url, role_tier: row.tier, confidence: row.tier ? 'medium' : 'low', match_reason: (row.t && row.t.person_match_reason) || '' };
      const personSrc = String((base.source || (row.t && row.t.person_source) || 'web')).split('+')[0] || 'web';
      const contact = { ...base, name: base.name || row.person.name, email: em.email, email_status: em.email_status, email_verified: em.email_verified || false, email_checked_at: em.email_checked_at || null, source: [personSrc, em.via].filter(Boolean).join('+') };
      outreach[row.id] = { ...(outreach[row.id] || {}), contact };  // → dashboard + Gmail draft recipient
      changedOutreach = true;
      if (row.t) { row.t.person_email = em.email; row.t.person_email_status = em.email_status; row.t.person_email_verified = em.email_verified || false; row.t.person_email_checked_at = em.email_checked_at || null; row.t.person_source = contact.source; changedResearch = true; } // → research_targets.json
      up.upgraded++; if (em.email_status === 'verified') up.verified++; else if (em.email_status === 'published') up.published++;
      console.log(`[find-contacts] upgrade ${row.person.name} @ ${row.domain}: ${curEmail || 'none'} → ${em.email} (${em.email_status} via ${em.via})`);
    }
  } catch (e) { console.error(`[find-contacts] email-upgrade error (continuing): ${e.message}`); }
  console.log(`[find-contacts] email-upgrade done: upgraded=${up.upgraded} (verified=${up.verified}, published=${up.published}).`);

  console.log(`[find-contacts] found people=${tally.people} (A=${tally.A} B=${tally.B} C=${tally.C}) · verified/real emails=${tally.emails} · no-person=${tally.none}`);
  if (changedOutreach) { await writeFile(OUTREACH_PATH, JSON.stringify(outreach, null, 2) + '\n'); console.log('[find-contacts] wrote outreach.json'); }
  if (changedResearch) { await writeFile(RESEARCH_PATH, JSON.stringify(researchRaw, null, 1) + '\n'); console.log('[find-contacts] wrote research_targets.json'); }
  if (!changedOutreach && !changedResearch) console.log('[find-contacts] nothing found; files unchanged.');
}

// Run only when invoked directly (not when imported by a test that wants roleTier()).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main()
    .catch((err) => { console.error('[find-contacts] unexpected error (exiting 0):', err); })
    .finally(() => process.exit(0));
}

export { roleTier, isCompanyInbox, splitName, emailPatterns };
