// RETIRED — the web product-catalog scraper is disabled.
//
// products.json is now the REAL client product list, imported from the client's SharePoint sales files by
// scripts/sharepoint/fetch-products.mjs (workflow: .github/workflows/products-sync.yml). This old scraper
// pulled a best-guess catalog from kusumgar.com and would OVERWRITE the real data, so it is neutered: it
// never touches products.json. Its workflow (products-refresh.yml) has been removed.
//
// (The separate NEW-product opportunity discovery — scripts/find-newproduct-targets.mjs — is unrelated and
// still active.)
console.log('[scrape-products] retired — the real product list now comes from SharePoint (scripts/sharepoint/fetch-products.mjs). products.json left untouched.');
process.exit(0);
