import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  mergeChangeHistory,
  mergeWithExisting,
  normalizedPeriodFromText,
  parseExportDestinationTotal,
  parseExportDestinations,
  parsePassengerNevExportSummary,
  parseRanking,
  summarizeDataChanges
} from "./update-data.mjs";

assert.equal(normalizedPeriodFromText("Jan-Apr 2026"), "2026-01/2026-04");
assert.equal(normalizedPeriodFromText("Jun 2026"), "2026-06");
const parsedRanking = parseRanking(
  '<h2>Top automakers in China with highest NEV exports in Jun 2026</h2><table><tr><td>1</td><td>Fixture Brand</td><td>1,234</td><td>12.3%</td></tr></table>',
  /Top automakers in China with highest NEV exports in Jun 2026/i,
  "test"
);
assert.equal(parsedRanking.period, "2026-06");
assert.equal(parsedRanking.rows[0].value, 1234);
const parsedDestinations = parseExportDestinations(
  "Top 10 destination countries by China's new energy passenger vehicle exports Jan-Apr 2026 Brazil: 218,096 NEV passenger vehicles (+220.9% YoY) Belgium: 125,990 NEV passenger vehicles (+41.7% YoY)"
);
assert.equal(parsedDestinations.period, "2026-01/2026-04");
assert.equal(parsedDestinations.rows.length, 2);
assert.equal(parsedDestinations.rows[0].value, 218096);
const parsedNoisyDestinations = parseExportDestinations(
  "Apr 2026 unrelated context Top 10 destination countries by China's new energy passenger vehicle exports Jan\u2013Apr 2026 Brazil: 218,096 NEV passenger vehicles (+220.9% YoY)"
);
assert.equal(parsedNoisyDestinations.period, "2026-01/2026-04");
assert.deepEqual(
  parseExportDestinationTotal("For the first four months of 2026, cumulative new energy PV exports reached 1.306 million units."),
  { period: "2026-01/2026-04", value: 1306000 }
);
const parsedExportSummary = parsePassengerNevExportSummary(
  '<meta property="article:published_time" content="2026-07-08T00:00:00Z">China\'s NEV exports totaled 499,000 units in June, a 152.7% surge from a year earlier and a 17.6% increase from May.'
);
assert.deepEqual(parsedExportSummary, { period: "2026-06", value: 499000, yoyPct: 152.7, momPct: 17.6 });

const existing = JSON.parse(await fs.readFile("data/china-ev-data.json", "utf8"));
const firstMonth = existing.months[0];
const firstBydValue = existing.brands.BYD[0];
const firstMarketMonth = existing.market.months[0];
const firstRetailValue = existing.market.series.passengerNevRetail[0];
const sourceCount = existing.market.sourceHistory.cpcaRetail.length;
const oldBydNewsUrls = new Set(existing.news.BYD.map(item => item.url));
const futureMonth = "2099-12";
const futureYtdPeriod = "2099-01/2099-12";
const retailPeriodCount = Object.keys(existing.market.brandRetailHistory.latest).length;
const exportPeriodCount = Object.keys(existing.market.exportHistory.brandLatest).length;
const destinationPeriodCount = new Set(Object.values(existing.market.exportHistory.destinations).map(snapshot => (
  JSON.stringify(snapshot.rows || [])
))).size;
const existingChangeEventCount = new Set((existing.changeHistory || []).map(event => (
  `${event.changedAt}|${JSON.stringify(event.changes)}`
))).size;

const freshNews = Array.from({ length: 22 }, (_, index) => ({
  brand: "BYD",
  kind: "TEST",
  source: "Accumulation test fixture",
  title: `Synthetic news snapshot ${index + 1}`,
  summary: "Fixture only; never written to production data.",
  url: `https://example.com/news-snapshot-${index + 1}`,
  publishedAt: `2026-07-${String(31 - index).padStart(2, "0")}`
}));

const fresh = {
  fetchedAt: "2026-08-01T00:00:00.000Z",
  newsFetchedAt: "2026-08-01T00:00:00.000Z",
  unit: "vehicles",
  months: [futureMonth],
  brands: Object.fromEntries(Object.keys(existing.brands).map(brand => [
    brand,
    [brand === "BYD" ? 1234567 : null]
  ])),
  market: {
    fetchedAt: "2026-08-01T00:00:00.000Z",
    unit: "vehicles",
    months: [futureMonth],
    series: { passengerNevRetail: [2345678] },
    latestBrandRetail: {
      period: futureMonth,
      scope: "accumulation test fixture",
      status: "test",
      rows: [{ rank: 1, brand: "Fixture Brand", value: 1, sharePct: 1 }]
    },
    ytdBrandRetail: {
      period: futureYtdPeriod,
      scope: "accumulation test fixture",
      status: "test",
      rows: [{ rank: 1, brand: "Fixture Brand", value: 1, sharePct: 1 }]
    },
    latestBrandExports: {
      period: futureMonth,
      scope: "export accumulation test fixture",
      status: "test",
      total: 10,
      rows: [{ rank: 1, brand: "Fixture Brand", value: 10, sharePct: 100 }]
    },
    ytdBrandExports: {
      period: futureYtdPeriod,
      scope: "export accumulation test fixture",
      status: "test",
      rows: [{ rank: 1, brand: "Fixture Brand", value: 70, sharePct: 100 }]
    },
    latestExportDestinations: {
      period: futureYtdPeriod,
      scope: "destination accumulation test fixture",
      status: "test",
      total: 10,
      top10Total: 10,
      coveragePct: 100,
      rows: [{ rank: 1, country: "Fixture Country", region: "Test", value: 10, yoyPct: 1 }]
    },
    sources: {
      cpcaRetail: {
        publisher: "Accumulation test fixture",
        url: "https://example.com/accumulation-source",
        publishedAt: "2026-08-01",
        status: "test"
      }
    },
    definitions: {}
  },
  news: { BYD: freshNews },
  sources: existing.sources,
  errors: [],
  assumptions: existing.assumptions
};

const initialized = mergeWithExisting(fresh, null);
assert.equal(initialized.schemaVersion, 3);
assert.equal(initialized.news.BYD.length, 20);
assert.equal(Object.hasOwn(initialized, "newsArchive"), false);
assert.ok(initialized.market.brandRetailHistory.latest[futureMonth]);
assert.ok(initialized.market.exportHistory.brandLatest[futureMonth]);
assert.equal(initialized.market.latestExportDestinations.period, futureYtdPeriod);
assert.equal(initialized.market.sourceHistory.cpcaRetail.length, 1);

const merged = mergeWithExisting(fresh, existing);
assert.equal(merged.brands.BYD[merged.months.indexOf(firstMonth)], firstBydValue);
assert.equal(merged.brands.BYD[merged.months.indexOf(futureMonth)], 1234567);
assert.equal(
  merged.market.series.passengerNevRetail[merged.market.months.indexOf(firstMarketMonth)],
  firstRetailValue
);
assert.equal(
  merged.market.series.passengerNevRetail[merged.market.months.indexOf(futureMonth)],
  2345678
);
assert.equal(merged.news.BYD.length, 20);
assert.equal(merged.news.BYD.some(item => oldBydNewsUrls.has(item.url)), false);
assert.equal(Object.hasOwn(merged, "newsArchive"), false);
assert.ok(merged.market.brandRetailHistory.latest[existing.market.latestBrandRetail.period]);
assert.ok(merged.market.brandRetailHistory.latest[futureMonth]);
assert.equal(merged.market.latestBrandRetail.period, futureMonth);
assert.ok(merged.market.exportHistory.brandLatest[existing.market.latestBrandExports.period]);
assert.ok(merged.market.exportHistory.brandLatest[futureMonth]);
assert.ok(merged.market.exportHistory.destinations[existing.market.latestExportDestinations.period]);
assert.ok(merged.market.exportHistory.destinations[futureYtdPeriod]);
assert.equal(merged.market.latestBrandExports.period, futureMonth);
assert.equal(merged.market.latestExportDestinations.period, futureYtdPeriod);
assert.equal(merged.market.sourceHistory.cpcaRetail.length, sourceCount + 1);
assert.equal(merged.market.sources.cpcaRetail.url, "https://example.com/accumulation-source");

const mergedTwice = mergeWithExisting(fresh, merged);
assert.equal(mergedTwice.news.BYD.length, 20);
assert.equal(mergedTwice.market.sourceHistory.cpcaRetail.length, sourceCount + 1);
assert.equal(Object.keys(mergedTwice.market.brandRetailHistory.latest).length, retailPeriodCount + 1);
assert.equal(Object.keys(mergedTwice.market.exportHistory.brandLatest).length, exportPeriodCount + 1);
assert.equal(Object.keys(mergedTwice.market.exportHistory.destinations).length, destinationPeriodCount + 1);

const changes = summarizeDataChanges(existing, merged);
const eventTime = "2026-08-01T00:00:00.000Z";
const history = mergeChangeHistory(existing, eventTime, changes);
const repeatedHistory = mergeChangeHistory({ ...existing, changeHistory: history }, eventTime, changes);
const initializedHistory = mergeChangeHistory(null, eventTime, ["Initialized test store"]);
assert.equal(history.length, existingChangeEventCount + 1);
assert.equal(repeatedHistory.length, history.length);
assert.equal(initializedHistory.length, 1);
assert.equal(new Set(history.map(event => `${event.changedAt}|${JSON.stringify(event.changes)}`)).size, history.length);

console.log(JSON.stringify({
  retainedBrandStart: firstMonth,
  retainedMarketStart: firstMarketMonth,
  monthsAfterMerge: merged.months.length,
  marketMonthsAfterMerge: merged.market.months.length,
  replaceableNewsSnapshot: merged.news.BYD.length,
  retailRankingPeriodsAfterMerge: Object.keys(merged.market.brandRetailHistory.latest).length,
  exportRankingPeriodsAfterMerge: Object.keys(merged.market.exportHistory.brandLatest).length,
  destinationPeriodsAfterMerge: Object.keys(merged.market.exportHistory.destinations).length,
  sourceSnapshotsAfterMerge: merged.market.sourceHistory.cpcaRetail.length,
  idempotentSecondMerge: true
}, null, 2));
