# China EV Market Dashboard

Online dashboard for China EV market demand, domestic retail share, exports, batteries, dealer inventory, company-reported deliveries, and brand news.

## How it works

- `index.html` renders five views: market overview, brand competition, demand quality, company/news, and data definitions.
- `data/china-ev-data.json` is the canonical append-and-merge store.
- `data/china-ev-data.js` mirrors the JSON so the dashboard can also be opened directly as a local HTML file.
- `.github/workflows/update-data.yml` runs hourly and deploys GitHub Pages after checking for source changes.
- `scripts/update-data.mjs` discovers recent CnEVPost market articles, reads CPCA/CAAM/CABIA tables, reads CADA inventory data, and retains historical months.
- Missing or threshold-only disclosures remain `null`; the updater never estimates an exact value.

## Data scopes

- China market retail and market share: CPCA via CnEVPost.
- China NEV domestic sales, exports, BEV and PHEV: CAAM via CnEVPost.
- Battery installations: CABIA via CnEVPost.
- Dealer inventory: China Automobile Dealers Association.
- Company-reported deliveries/sales and news: CnEVPost brand pages.

Company-reported series are kept separate from China domestic retail because geography and product definitions differ by brand.

## Local preview

Open `index.html` directly, or run a static web server in this directory. The embedded data mirror allows direct-file preview without a terminal.

## Enable GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to repository Settings > Pages.
3. Set Source to `GitHub Actions`.
4. The included workflow will deploy the site automatically.
