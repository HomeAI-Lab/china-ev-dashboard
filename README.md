# China EV Deliveries Dashboard

Online dashboard for China EV monthly deliveries/sales using data scraped from CnEVPost brand pages.

## How it works

- `index.html` renders the dashboard on GitHub Pages.
- `data/china-ev-data.json` stores the latest scraped data.
- `.github/workflows/update-data.yml` runs hourly and updates the JSON file when CnEVPost changes.
- `scripts/update-data.mjs` reads only CnEVPost SEO tables and does not invent missing numbers.

## Enable GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to repository Settings > Pages.
3. Set Source to `GitHub Actions`.
4. The included workflow will deploy the site automatically.
