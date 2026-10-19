# Kusumgar Growth Engine

An AI sales-employee dashboard for **Kusumgar** (technical-textile / defence-fabric
manufacturer). It turns two growth motions into one visual cockpit:

1. **Exhibitions** — track global trade shows, sort exhibitors into customers vs. competitors.
2. **Outbound** — research a product, build a target list, find the buyer, send the email.

We build it in **5 phases**. This repo currently ships **Phase 1**: the foundation shell
plus a fully-working **Exhibitions** tab (Overview charts + filterable List with a
persistent relevance triage). The other four tabs are intentional placeholders.

## Architecture

- **Pure static site** served from `public/`. No build step, no framework.
- Plain HTML + one ES-module (`public/js/app.js`) + committed JSON in `public/data/`.
- The UI **always** just reads committed JSON via `fetch("data/xxx.json")`. Later phases
  add GitHub Actions that scrape data and commit fresh JSON — the UI never changes.
- [Tailwind](https://tailwindcss.com) via CDN, Google Fonts (Inter + Plus Jakarta Sans).
- **All charts are hand-built inline SVG.** No chart library.

```
public/
├── index.html          # the shell (header, tabs)
├── js/app.js           # all logic (ES module)
└── data/
    ├── exhibitions.json # 44 seed shows
    └── meta.json        # { updated_at, exhibitions_total }
```

## Run locally

Any static server works — there is nothing to build:

```bash
cd public
python3 -m http.server 8080
# open http://localhost:8080
```

## Deploy — Cloudflare Pages (one-time setup, then fully automated)

Deployment is **automatic on every push to GitHub**. Configure this **once** and it
stays automated forever — no manual deploy step is ever needed again:

1. In the **Cloudflare dashboard → Workers & Pages → Create → Pages**, choose
   **Connect to Git** and select the `techmuns/kusumgar-growth` repository.
2. Set the build configuration:
   - **Framework preset:** `None`
   - **Build command:** *(leave empty)*
   - **Build output directory:** `public`
3. Save. Cloudflare now redeploys automatically on every push to the production branch.

That's the whole setup. From then on, every commit — including the JSON that future
GitHub Actions will scrape and commit — ships to the live site with zero manual steps.

## Roadmap

- **Phase 1 (this build)** — Foundation shell + Exhibitions tab. ✅
- **Phase 2** — Products tab + a GitHub Action that scrapes kusumgar.com into a product catalog.
- **Phase 3** — Leads (target companies + buyers).
- **Phase 4** — Competitors intelligence.
- **Phase 5** — Outreach (cold-email machine).

## Shared exhibition calendar — October 2026

`public/data/exhibitions.json` is the shared catalogue consumed by Kusumgar
Research Central's **Exhibitions** table. This integration contains event dates,
location, market relevance and published registration links; it does not collect
Signals, company news, buyers or outreach.

`Discover exhibitions` now runs every six hours using direct public HTTP reads,
with no paid search, scraping or model credentials. The bounded queue rotates
through `scripts/exhibition-sources.json`, including reviewed organisers and
paginated EventsEye listings. JSON-LD event data and reviewed date expressions
update existing editions; directory rows discover new events. At most 24 pages
and five minutes are used per run. The oldest-attempted queue includes newly discovered organiser event pages;
source receipts distinguish successful event data from unresolved formats. A failed or
unparseable page remains an explicit follow-up, not evidence of fresh coverage.

`public/data/exhibition-checks.json` distinguishes attempts from successful event
extraction. Previous dates and evidence remain retained. Registration URLs are
kept only when actually published; absent URLs stay absent. Market assignments
express event relevance, not material capabilities or confirmed participation.

Updates use `codex/*` data pull requests, exact-head Exhibition checks and the
trusted-main publication workflow. Required reviews remain gates. The existing
legacy paid discovery scripts remain in Git history/source but are no longer
invoked by the exhibition schedule. Research Central imports a pinned catalogue
commit hourly and uses its existing checked publication/deployment flow. Source
failures and blocked publication can delay freshness; no exhaustive coverage is
claimed.

Organiser event announcements can discover new CBRN and parachute events with
unknown dates, then queue their exact event pages for a later bounded detail read.
The Airship Association next-conference statement retains its literal location
and season/year. Existing owner segment categories remain intact. Registration
links use the actual organiser-published destination; URL text does not establish
an edition or whether booking is open.
