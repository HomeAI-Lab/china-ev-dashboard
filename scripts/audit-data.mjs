import fs from "node:fs/promises";

import { latestPeriodKey } from "./update-data.mjs";

const dataPath = process.argv[2] || "data/china-ev-data.json";
const mirrorPath = process.argv[3] || "data/china-ev-data.js";
const htmlPath = process.argv[4] || "index.html";
const expectedBrands = [
  "BYD",
  "Nio",
  "Xpeng",
  "Li Auto",
  "Tesla China",
  "Zeekr",
  "Xiaomi EV",
  "Leapmotor",
  "Huawei HIMA"
];
const requiredMarketSeries = [
  "passengerNevRetail",
  "passengerNevRetailPenetrationPct",
  "passengerCarRetail",
  "passengerNevWholesale",
  "nevSalesCaam",
  "nevDomesticSalesCaam",
  "nevExportsCaam",
  "nevPenetrationCaamPct",
  "bevSalesCaam",
  "phevSalesCaam",
  "passengerBevRetail",
  "passengerPhevRetail",
  "passengerErevRetail",
  "batteryInstallationsGwh",
  "batteryLfpGwh",
  "batteryTernaryGwh",
  "dealerInventoryCoefficient",
  "dealerInventoryAlertPct"
];
const requiredMarketSources = [
  "cpcaRetail",
  "cpcaWholesale",
  "caam",
  "brandRetail",
  "exportBrands",
  "exportDestinations",
  "battery",
  "dealerInventory"
];

const failures = [];
const warnings = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const validNumber = value => value === null || (Number.isFinite(value) && value >= 0);
const lastValueIndex = values => {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null && values[index] !== undefined) return index;
  }
  return -1;
};
const isSortedUnique = values => values.every((value, index) => (
  index === 0 || values[index - 1] < value
));

const data = JSON.parse(await fs.readFile(dataPath, "utf8"));
const mirrorText = await fs.readFile(mirrorPath, "utf8");
const html = await fs.readFile(htmlPath, "utf8");
const mirrorMatch = mirrorText.match(/^window\.CHINA_EV_DATA\s*=\s*([\s\S]*);\s*$/);
check(Boolean(mirrorMatch), "JavaScript data mirror has an invalid wrapper");
if (mirrorMatch) {
  const mirror = JSON.parse(mirrorMatch[1]);
  check(JSON.stringify(mirror) === JSON.stringify(data), "JSON and JavaScript data mirrors differ");
}
const inlineScripts = [...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(Boolean);
for (const source of inlineScripts) {
  try {
    new Function(source);
  } catch (error) {
    failures.push(`Inline dashboard script has invalid syntax: ${error.message}`);
  }
}
const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
const duplicateIds = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
check(duplicateIds.length === 0, `Dashboard contains duplicate IDs: ${[...new Set(duplicateIds)].join(", ")}`);

check(data.schemaVersion === 3, "schemaVersion must be 3");
check(data.unit === "vehicles", "Top-level unit must be vehicles");
check(Array.isArray(data.months) && data.months.length > 0, "Brand month axis is missing");
check(isSortedUnique(data.months || []), "Brand month axis must be sorted and unique");
check((data.months || []).every(month => /^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month)), "Brand month axis contains an invalid month");

for (const brand of expectedBrands) {
  const values = data.brands?.[brand];
  check(Array.isArray(values), `${brand} series is missing`);
  if (!Array.isArray(values)) continue;
  check(values.length === data.months.length, `${brand} series length does not match brand months`);
  check(values.every(validNumber), `${brand} series contains an invalid value`);
  const latestIndex = lastValueIndex(values);
  check(latestIndex >= 0, `${brand} has no populated value`);
  check(latestIndex >= data.months.length - 2, `${brand} latest populated month is unexpectedly stale`);
}

const market = data.market;
check(Boolean(market), "Market dataset is missing");
check(market?.unit === "vehicles", "Market unit must be vehicles");
check(Array.isArray(market?.months) && market.months.length > 0, "Market month axis is missing");
check(isSortedUnique(market?.months || []), "Market month axis must be sorted and unique");
for (const name of requiredMarketSeries) {
  const values = market?.series?.[name];
  check(Array.isArray(values), `Market series ${name} is missing`);
  if (!Array.isArray(values)) continue;
  check(values.length === market.months.length, `Market series ${name} length does not match market months`);
  check(values.every(validNumber), `Market series ${name} contains an invalid value`);
  check(lastValueIndex(values) >= 0, `Market series ${name} has no populated value`);
}

const rankingPointers = [
  [market?.brandRetailHistory?.latest, market?.latestBrandRetail, "monthly brand retail"],
  [market?.brandRetailHistory?.ytd, market?.ytdBrandRetail, "YTD brand retail"],
  [market?.exportHistory?.brandLatest, market?.latestBrandExports, "monthly brand exports"],
  [market?.exportHistory?.brandYtd, market?.ytdBrandExports, "YTD brand exports"],
  [market?.exportHistory?.destinations, market?.latestExportDestinations, "export destinations"]
];
for (const [history, current, label] of rankingPointers) {
  check(history && Object.keys(history).length > 0, `${label} history is missing`);
  check(Boolean(current?.period), `${label} current snapshot is missing`);
  if (history && current?.period) {
    check(latestPeriodKey(history) === current.period, `${label} current snapshot is not the latest period`);
    check(Array.isArray(current.rows) && current.rows.length > 0, `${label} current rows are missing`);
  }
}
const destinationHistory = market?.exportHistory?.destinations || {};
const destinationRowFingerprints = Object.entries(destinationHistory).map(([period, snapshot]) => [
  period,
  JSON.stringify(snapshot.rows || [])
]);
for (const [period, fingerprint] of destinationRowFingerprints) {
  const duplicate = destinationRowFingerprints.find(([otherPeriod, otherFingerprint]) => (
    otherPeriod !== period && otherFingerprint === fingerprint
  ));
  check(!duplicate, `Export destination periods ${period} and ${duplicate?.[0]} contain duplicate snapshots`);
}
if (market?.latestExportDestinations?.total != null) {
  check(Number.isFinite(market.latestExportDestinations.top10Total), "Export destination Top 10 total is missing");
  check(Number.isFinite(market.latestExportDestinations.coveragePct), "Export destination coverage is missing");
  const expectedCoverage = market.latestExportDestinations.top10Total / market.latestExportDestinations.total * 100;
  check(Math.abs(market.latestExportDestinations.coveragePct - expectedCoverage) < 0.000001, "Export destination coverage is inconsistent with published totals");
}

for (const sourceName of requiredMarketSources) {
  const source = market?.sources?.[sourceName];
  check(Boolean(source?.url), `Market source ${sourceName} is missing`);
  check(Array.isArray(market?.sourceHistory?.[sourceName]) && market.sourceHistory[sourceName].length > 0, `Market source history ${sourceName} is missing`);
}

check(data.newsPolicy?.mode === "replace-snapshot", "News policy must be replace-snapshot");
check(data.newsPolicy?.limitPerBrand === 20, "News snapshot limit must be 20 per brand");
for (const brand of expectedBrands) {
  const stories = data.news?.[brand];
  check(Array.isArray(stories), `${brand} news snapshot is missing`);
  if (!Array.isArray(stories)) continue;
  check(stories.length === 20, `${brand} news snapshot must contain 20 stories`);
  check(new Set(stories.map(item => item.url)).size === stories.length, `${brand} news snapshot contains duplicate URLs`);
  check(stories.every(item => item.title && item.url && /^20\d{2}-\d{2}-\d{2}$/.test(item.publishedAt || "")), `${brand} news snapshot has incomplete metadata`);
  check(stories.every((item, index) => index === 0 || stories[index - 1].publishedAt >= item.publishedAt), `${brand} news snapshot is not sorted newest first`);
}

const changeEvents = data.changeHistory || [];
const changeKeys = changeEvents.map(event => `${event.changedAt}|${JSON.stringify(event.changes)}`);
check(new Set(changeKeys).size === changeKeys.length, "Change history contains duplicate events");
check(Number.isFinite(Date.parse(data.lastCheckedAt)), "lastCheckedAt is missing or invalid");
check(Number.isFinite(Date.parse(data.lastDataChangeAt)), "lastDataChangeAt is missing or invalid");
if (Number.isFinite(Date.parse(data.lastCheckedAt))) {
  const ageHours = (Date.now() - Date.parse(data.lastCheckedAt)) / 3_600_000;
  if (ageHours > 6) warnings.push(`lastCheckedAt is ${ageHours.toFixed(1)} hours old`);
}
for (const error of data.errors || []) warnings.push(`Source warning: ${error}`);

const summary = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  dataCheckedAt: data.lastCheckedAt,
  brandCoverage: `${data.months[0]} to ${data.months.at(-1)}`,
  brands: expectedBrands.length,
  marketCoverage: `${market?.months?.[0]} to ${market?.months?.at(-1)}`,
  marketSeries: Object.keys(market?.series || {}).length,
  newsStories: Object.values(data.news || {}).reduce((sum, items) => sum + items.length, 0),
  sourceGroups: Object.keys(market?.sources || {}).length,
  inlineScripts: inlineScripts.length,
  htmlIds: htmlIds.length,
  failures,
  warnings
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 1;
