import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sources = {
  "BYD": "https://cnevpost.com/byd/",
  "Nio": "https://cnevpost.com/nio/",
  "Xpeng": "https://cnevpost.com/xpeng/",
  "Li Auto": "https://cnevpost.com/li-auto/",
  "Tesla China": "https://cnevpost.com/tesla/",
  "Zeekr": "https://cnevpost.com/zeekr/",
  "Xiaomi EV": "https://cnevpost.com/xiaomi/",
  "Leapmotor": "https://cnevpost.com/leapmotor/",
  "Huawei HIMA": "https://cnevpost.com/huawei/"
};

const marketFallbackSources = {
  retail: "https://cnevpost.com/2026/07/08/china-nev-retail-sales-jun-2026/",
  wholesale: "https://cnevpost.com/2026/07/02/cpca-china-jun-2026-nev-wholesale/",
  preliminary: "https://cnevpost.com/2026/07/03/chinas-nev-retail-jun-cpca-preliminary-data/",
  caam: "https://cnevpost.com/2026/07/09/china-jun-2026-nev-sales-caam/",
  brandRetail: "https://cnevpost.com/2026/07/10/automakers-share-china-nev-market-jun-2026/",
  exportBrands: "https://cnevpost.com/2026/07/10/automakers-share-china-nev-exports-jun-2026/",
  exportDestinations: "https://autonews.gasgoo.com/articles/news/chinas-passenger-vehicle-export-overview-jan-apr-2026-brazil-leads-overallgasgoo-automotive-research-institute-2069316207587815425",
  exportDestinationTotal: "https://autonews.gasgoo.com/articles/news/chinas-passenger-vehicle-market-faces-yoy-drop-in-apr-retail-sales-wholesales-but-exports-surge-2054095851151056896",
  battery: "https://cnevpost.com/2026/06/11/china-may-2026-ev-battery-installations/",
  dealerInventory: "https://www.cada.cn/Data/list_85_1.html"
};

const marketDefinitions = {
  passengerNevRetail: "Domestic end-customer retail sales of passenger NEVs reported by CPCA.",
  passengerNevWholesale: "Passenger NEV wholesale sales from automakers; includes vehicles that may be exported.",
  nevSalesCaam: "CAAM NEV sales including domestic sales and exports; covers BEV, PHEV and fuel-cell vehicles.",
  passengerNevExportsCpca: "China-made passenger NEV exports reported by CPCA; narrower than CAAM's all-vehicle NEV export total.",
  exportDestinations: "Destination-country ranking for China-made new-energy passenger vehicle exports; period may lag monthly market data.",
  companyReported: "Company-reported deliveries or sales. Geography and product scope differ by brand and must not be summed as China domestic retail.",
  dealerInventoryCoefficient: "Ending dealer inventory divided by sales for the month; above 1.5 is CADA's warning level."
};

const monthIndex = new Map([
  ["january", "01"], ["february", "02"], ["march", "03"], ["april", "04"],
  ["may", "05"], ["june", "06"], ["july", "07"], ["august", "08"],
  ["september", "09"], ["october", "10"], ["november", "11"], ["december", "12"]
]);

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ChinaEVDataBot/1.0; +https://github.com/)",
        "accept": "text/html,application/xhtml+xml"
      }
    }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve(body));
    });
    req.setTimeout(30000, () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
  });
}

function cleanCell(value) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .trim();
}

function cleanText(value) {
  return cleanCell(value).replace(/\s+/g, " ").trim();
}

function absoluteUrl(url) {
  return new URL(url, "https://cnevpost.com").toString();
}

function numberFromCell(value) {
  const text = cleanCell(value);
  if (!text) return null;
  const normalized = text.replace(/,/g, "");
  if (!/^\d+$/.test(normalized)) return null;
  return Number(normalized);
}

function decimalFromCell(value) {
  const text = cleanCell(value).replace(/,/g, "");
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function articleDateFromUrl(url) {
  const match = String(url || "").match(/\/(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])(?:\/|$)/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function articlePublishedAt(html, url = "") {
  const value = html.match(/<meta[^>]+(?:property|name)=["']article:published_time["'][^>]+content=["']([^"']+)/i)?.[1]
    || html.match(/<time[^>]+datetime=["']([^"']+)/i)?.[1]
    || null;
  return value ? value.slice(0, 10) : articleDateFromUrl(url);
}

function extractArticleLinks(html) {
  const seen = new Set();
  const links = [];
  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = cleanText(match[2]);
    if (!title || title.length < 12) continue;
    let url;
    try {
      url = absoluteUrl(match[1]);
    } catch {
      continue;
    }
    if (!url.startsWith("https://cnevpost.com/") || seen.has(url)) continue;
    seen.add(url);
    links.push({ title, url });
  }
  return links;
}

function findArticle(links, include, exclude = /$a/) {
  return links.find(item => include.test(`${item.title} ${item.url}`) && !exclude.test(`${item.title} ${item.url}`))?.url;
}

function tablesWithContext(html) {
  return [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map(match => ({
    html: match[1],
    context: cleanText(html.slice(Math.max(0, match.index - 900), match.index))
  }));
}

function tableForTitle(html, titlePattern) {
  return tablesWithContext(html).find(table => titlePattern.test(table.context))?.html || null;
}

function parseYearGrid(html, titlePattern) {
  const table = tableForTitle(html, titlePattern);
  if (!table) return {};
  const header = table.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || table.match(/<tr[^>]*>[\s\S]*?<\/tr>/i)?.[0] || "";
  const years = [...header.matchAll(/<th[^>]*>\s*(20\d{2})\s*<\/th>/gi)].map(match => match[1]);
  if (!years.length) return {};

  const records = {};
  for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
    const month = monthIndex.get(cleanCell(cells[0] || "").toLowerCase());
    if (!month) continue;
    years.forEach((year, idx) => {
      const value = decimalFromCell(cells[idx + 1] || "");
      if (value !== null) records[`${year}-${month}`] = value;
    });
  }
  return records;
}

function parseDatedGrid(html, titlePattern) {
  const table = tableForTitle(html, titlePattern);
  if (!table) return [];
  const rows = [];
  for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => cleanCell(match[1]));
    const date = cells[0]?.match(/^([A-Za-z]{3})\s+(20\d{2})$/);
    if (!date) continue;
    const month = monthIndex.get({
      jan: "january", feb: "february", mar: "march", apr: "april", may: "may", jun: "june",
      jul: "july", aug: "august", sep: "september", oct: "october", nov: "november", dec: "december"
    }[date[1].toLowerCase()]);
    if (!month) continue;
    rows.push({
      month: `${date[2]}-${month}`,
      values: cells.slice(1).map(decimalFromCell)
    });
  }
  return rows;
}

function parseRanking(html, titlePattern, scope, status = "final") {
  const matched = tablesWithContext(html).find(table => titlePattern.test(table.context));
  if (!matched) return null;
  const table = matched.html;
  const rows = [];
  for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => cleanCell(match[1]));
    if (cells.length < 4 || !/^\d+$/.test(cells[0])) continue;
    const value = decimalFromCell(cells[2]);
    const sharePct = decimalFromCell(cells[3]);
    if (value === null || sharePct === null) continue;
    rows.push({ rank: Number(cells[0]), brand: cells[1] === "HIMA" ? "Huawei HIMA" : cells[1], value, sharePct });
  }
  if (!rows.length) return null;
  const period = normalizedPeriodFromText(matched.context) || "latest";
  return { period, scope, status, rows };
}

function monthNumber(value) {
  const key = String(value || "").trim().toLowerCase().slice(0, 3);
  return {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
  }[key] || null;
}

function normalizedPeriodFromText(value) {
  const text = cleanText(value);
  const ytd = text.match(/Jan(?:uary)?\s*[-\u2013\u2014]\s*([A-Za-z]+)\s+(20\d{2})/i);
  if (ytd) {
    const endMonth = monthNumber(ytd[1]);
    return endMonth ? `${ytd[2]}-01/${ytd[2]}-${endMonth}` : null;
  }
  const single = text.match(/\b([A-Za-z]{3,9})\s+(20\d{2})\b/i);
  if (!single) return null;
  const month = monthNumber(single[1]);
  return month ? `${single[2]}-${month}` : null;
}

function exportRegion(country) {
  return {
    Brazil: "Latin America",
    Belgium: "Europe",
    UK: "Europe",
    Australia: "Asia-Pacific",
    Germany: "Europe",
    Italy: "Europe",
    UAE: "Middle East",
    "South Korea": "Asia-Pacific",
    Spain: "Europe",
    Thailand: "Southeast Asia"
  }[country] || "Other";
}

function parseExportDestinations(html) {
  const text = cleanText(html);
  const start = text.search(/Top 10 destination countries by China's new energy passenger vehicle exports/i);
  const relevant = start >= 0 ? text.slice(start, start + 5000) : text;
  const rows = [];
  const pattern = /([A-Z][A-Za-z ]{1,30}):\s*([\d,]+)\s+NEV passenger vehicles\s+\(([+-]?\d+(?:\.\d+)?)% YoY\)/g;
  for (const match of relevant.matchAll(pattern)) {
    rows.push({
      rank: rows.length + 1,
      country: match[1].trim(),
      region: exportRegion(match[1].trim()),
      value: Number(match[2].replace(/,/g, "")),
      yoyPct: Number(match[3])
    });
    if (rows.length === 10) break;
  }
  if (!rows.length) return null;
  return {
    period: normalizedPeriodFromText(relevant) || "latest",
    scope: "China new-energy passenger vehicle exports by destination",
    status: "final",
    rows
  };
}

function parseExportDestinationTotal(html) {
  const text = cleanText(html);
  const match = text.match(/cumulative new energy PV exports reached\s+([\d.]+)\s+million units/i);
  if (!match) return null;
  const between = text.match(/(?:between|from) January and ([A-Za-z]+)[^\d]{0,80}(20\d{2})/i);
  const firstFour = text.match(/first four months of (20\d{2})/i);
  const endMonth = between ? monthNumber(between[1]) : firstFour ? "04" : null;
  const year = between?.[2] || firstFour?.[1] || null;
  return {
    period: year && endMonth ? `${year}-01/${year}-${endMonth}` : null,
    value: Math.round(Number(match[1]) * 1_000_000)
  };
}

function parsePassengerNevExportSummary(html) {
  const text = cleanText(html);
  const match = text.match(/NEV exports totaled\s+([\d,]+) units in ([A-Za-z]+),\s+a ([\d.]+)% [^.]*?from a year earlier and a ([\d.]+)% increase from ([A-Za-z]+)/i);
  const publishedAt = articlePublishedAt(html);
  if (!match || !publishedAt) return null;
  const month = monthNumber(match[2]);
  if (!month) return null;
  const publishedYear = Number(publishedAt.slice(0, 4));
  const publishedMonth = Number(publishedAt.slice(5, 7));
  const year = Number(month) > publishedMonth ? publishedYear - 1 : publishedYear;
  return {
    period: `${year}-${month}`,
    value: Number(match[1].replace(/,/g, "")),
    yoyPct: Number(match[3]),
    momPct: Number(match[4])
  };
}

function parseCadaSeries(html) {
  const text = cleanText(html);
  const coefficient = {};
  const alert = {};
  for (const match of text.matchAll(/(20\d{2})年(\d{1,2})月(?:份)?汽车经销商库存系数为([0-9.]+)/g)) {
    coefficient[`${match[1]}-${String(Number(match[2])).padStart(2, "0")}`] = Number(match[3]);
  }
  for (const match of text.matchAll(/(20\d{2})年(\d{1,2})月(?:份)?中国汽车经销商库存预警指数为([0-9.]+)%/g)) {
    alert[`${match[1]}-${String(Number(match[2])).padStart(2, "0")}`] = Number(match[3]);
  }
  return { coefficient, alert };
}

function parseNarrativeMonthlyPoint(html, valuePattern) {
  const text = cleanText(html);
  const match = text.match(valuePattern);
  const publishedAt = articlePublishedAt(html);
  if (!match || !publishedAt) return {};
  const monthName = match[2].toLowerCase();
  const month = monthIndex.get(monthName);
  if (!month) return {};
  const publishedYear = Number(publishedAt.slice(0, 4));
  const publishedMonth = Number(publishedAt.slice(5, 7));
  const reportedYear = Number(month) > publishedMonth ? publishedYear - 1 : publishedYear;
  return { [`${reportedYear}-${month}`]: Number(match[1].replace(/,/g, "")) };
}

function parseWholesaleYtd(html) {
  const match = cleanText(html).match(/Cumulative NEV wholesale volume[^.]*?([\d,]+) units,\s*(up|down)\s*([\d.]+)% year-on-year/i);
  if (!match) return null;
  return {
    value: Number(match[1].replace(/,/g, "")),
    yoyPct: Number(match[3]) * (match[2].toLowerCase() === "down" ? -1 : 1)
  };
}

function parseBrandTable(html, brand) {
  const tables = [...html.matchAll(/<div[^>]*class="[^"]*cnevpost-seo-table[^"]*"[^>]*>[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/gi)]
    .map(match => match[1]);
  const table = tables.find(candidate => /<th[^>]*>\s*Month\s*<\/th>/i.test(candidate));
  if (!table) throw new Error(`No monthly table found for ${brand}`);

  const header = table.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || "";
  const years = [...header.matchAll(/<th[^>]*>\s*(20\d{2})\s*<\/th>/gi)].map(match => match[1]);
  if (!years.length) throw new Error(`No year columns found for ${brand}`);

  const records = new Map();
  for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
    const month = monthIndex.get(cleanCell(cells[0] || "").toLowerCase());
    if (!month) continue;
    years.forEach((year, idx) => {
      const value = numberFromCell(cells[idx + 1] || "");
      if (value !== null) records.set(`${year}-${month}`, value);
    });
  }
  if (!records.size) throw new Error(`No numeric monthly records found for ${brand}`);
  return Object.fromEntries([...records.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function parseBrandNews(html, brand) {
  const news = [];
  const seen = new Set();
  const articleRe = /<article\b[\s\S]*?<\/article>/gi;
  const fallbackRe = /<h3[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h3>([\s\S]*?)(?=<h3[^>]*>|<nav\b|<footer\b|$)/gi;

  for (const articleMatch of html.matchAll(articleRe)) {
    const article = articleMatch[0];
    const titleMatch = article.match(/<h[23][^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h[23]>/i);
    if (!titleMatch) continue;
    const summary = cleanText(article.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "");
    const url = absoluteUrl(titleMatch[1]);
    const item = {
      title: cleanText(titleMatch[2]),
      url,
      summary,
      publishedAt: articlePublishedAt(article, url)
    };
    if (!item.title || seen.has(item.url)) continue;
    seen.add(item.url);
    news.push(item);
    if (news.length >= 20) return news;
  }

  for (const match of html.matchAll(fallbackRe)) {
    const url = absoluteUrl(match[1]);
    const item = {
      title: cleanText(match[2]),
      url,
      summary: cleanText(match[3].match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || ""),
      publishedAt: articlePublishedAt(match[3], url)
    };
    if (!item.title || seen.has(item.url)) continue;
    seen.add(item.url);
    news.push(item);
    if (news.length >= 20) return news;
  }

  if (!news.length) console.warn(`No latest news found for ${brand}`);
  return news;
}

function latestNewsSnapshot(...groups) {
  const byUrl = new Map();
  const order = new Map();
  groups.flat().forEach((item, index) => {
    if (!item?.url || byUrl.has(item.url)) return;
    byUrl.set(item.url, item);
    order.set(item.url, index);
  });
  return [...byUrl.values()].sort((a, b) => {
    const byDate = String(b.publishedAt || "").localeCompare(String(a.publishedAt || ""));
    return byDate || order.get(a.url) - order.get(b.url);
  }).slice(0, 20);
}

async function discoverMarketSources() {
  const discovered = { ...marketFallbackSources };
  try {
    const [industryHtml, batteryHtml] = await Promise.all([
      fetchText("https://cnevpost.com/industry/"),
      fetchText("https://cnevpost.com/battery/")
    ]);
    const industryLinks = extractArticleLinks(industryHtml);
    const batteryLinks = extractArticleLinks(batteryHtml);
    discovered.retail = findArticle(
      industryLinks,
      /china.*nev retail sales|nev retail sales.*china/i,
      /preliminary|forecast|first week|weekly|seen at|jan \d+-/i
    ) || discovered.retail;
    discovered.preliminary = findArticle(
      industryLinks,
      /cpca preliminary data.*nev retail|nev retail.*cpca preliminary/i
    ) || discovered.preliminary;
    discovered.wholesale = findArticle(
      industryLinks,
      /cpca.*nev wholesale|nev wholesale.*cpca|nev-wholesale/i,
      /week|weekly/i
    ) || discovered.wholesale;
    discovered.caam = findArticle(industryLinks, /nev-sales-caam|caam.*nev sales/i) || discovered.caam;
    discovered.brandRetail = findArticle(industryLinks, /automakers.*share.*china.*nev market/i) || discovered.brandRetail;
    discovered.exportBrands = findArticle(industryLinks, /automakers.*share.*china.*nev exports|nev exports.*automakers/i) || discovered.exportBrands;
    discovered.exportDestinations = findArticle(industryLinks, /nev exports.*destination countries|destination countries.*nev exports/i) || discovered.exportDestinations;
    discovered.battery = findArticle(batteryLinks, /battery installations/i) || discovered.battery;
  } catch (error) {
    console.warn(`Market source discovery fell back to known URLs: ${error.message}`);
  }
  return discovered;
}

async function scrapeMarketData() {
  const urls = await discoverMarketSources();
  const errors = [];
  const pages = {};

  await Promise.all(Object.entries(urls).map(async ([key, url]) => {
    try {
      pages[key] = await fetchText(url);
    } catch (error) {
      errors.push(`Market ${key}: ${error.message}`);
    }
  }));

  const records = {};
  if (pages.retail) {
    records.passengerNevRetail = parseYearGrid(pages.retail, /China NEV Monthly Sales \(CPCA\)/i);
    records.passengerNevRetailPenetrationPct = parseYearGrid(pages.retail, /China Passenger NEV Penetration at Retail/i);
    records.passengerCarRetail = parseYearGrid(pages.retail, /China Passenger Car Retail Sales/i);
    records.passengerBevRetail = parseYearGrid(pages.retail, /China Passenger BEV Retail Sales/i);
    records.passengerPhevRetail = parseYearGrid(pages.retail, /China PHEV Monthly Sales/i);
    records.passengerErevRetail = parseYearGrid(pages.retail, /China EREV Monthly Sales/i);
  }
  if (pages.wholesale) {
    records.passengerNevWholesale = parseYearGrid(pages.wholesale, /China NEV Monthly Wholesale Sales \(CPCA\)/i);
  }
  if (pages.preliminary) {
    records.passengerNevWholesale ||= {};
    Object.assign(records.passengerNevWholesale, parseNarrativeMonthlyPoint(
      pages.preliminary,
      /Wholesale sales of passenger NEVs in China were ([\d,]+) units in ([A-Za-z]+)/i
    ));
  }
  if (pages.caam) {
    records.nevSalesCaam = parseYearGrid(pages.caam, /China Monthly NEV Sales \(Exports Included\)/i);
    records.nevPenetrationCaamPct = parseYearGrid(pages.caam, /China Monthly NEV Penetration/i);
    records.bevSalesCaam = parseYearGrid(pages.caam, /China Monthly BEV Sales/i);
    records.phevSalesCaam = parseYearGrid(pages.caam, /China Monthly PHEV Sales/i);
    records.nevDomesticSalesCaam = parseYearGrid(pages.caam, /China Monthly NEV Sales \(Excluding Exports\)/i);
    records.nevExportsCaam = parseYearGrid(pages.caam, /China Monthly NEV Exports/i);
  }
  if (pages.battery) {
    records.batteryInstallationsGwh = parseYearGrid(pages.battery, /China Monthly Power Battery Installations/i);
    const chemistry = parseDatedGrid(pages.battery, /China Monthly Power Battery Installations: Ternary vs LFP/i);
    records.batteryTernaryGwh = Object.fromEntries(chemistry.map(row => [row.month, row.values[0]]));
    records.batteryLfpGwh = Object.fromEntries(chemistry.map(row => [row.month, row.values[1]]));
  }
  if (pages.dealerInventory) {
    const cada = parseCadaSeries(pages.dealerInventory);
    records.dealerInventoryCoefficient = cada.coefficient;
    records.dealerInventoryAlertPct = cada.alert;
  }

  const nonEmptyRecords = Object.fromEntries(Object.entries(records).filter(([, values]) => Object.keys(values).length));
  const months = monthRange(Object.values(nonEmptyRecords));
  if (!months.length) return { market: null, errors: [...errors, "No market monthly table could be parsed"] };

  const series = {};
  for (const [name, values] of Object.entries(nonEmptyRecords)) {
    series[name] = months.map(month => values[month] ?? null);
  }

  const latestBrandRetail = pages.brandRetail
    ? parseRanking(
      pages.brandRetail,
      /Top automakers with highest passenger NEV retail sales in China in (?!Jan-)[A-Za-z]{3} 20\d{2}/i,
      "China passenger NEV retail sales"
    )
    : null;
  const ytdBrandRetail = pages.brandRetail
    ? parseRanking(
      pages.brandRetail,
      /Top automakers with highest NEV retail sales in China in Jan-[A-Za-z]{3} 20\d{2}/i,
      "China passenger NEV retail sales"
    )
    : null;
  const exportSummary = pages.retail ? parsePassengerNevExportSummary(pages.retail) : null;
  const latestBrandExports = pages.exportBrands
    ? parseRanking(
      pages.exportBrands,
      /Top automakers in China with highest NEV exports in (?!Jan-)[A-Za-z]{3} 20\d{2}/i,
      "China passenger NEV exports"
    )
    : null;
  if (latestBrandExports && exportSummary && latestBrandExports.period === exportSummary.period) {
    latestBrandExports.total = exportSummary.value;
    latestBrandExports.totalYoyPct = exportSummary.yoyPct;
    latestBrandExports.totalMomPct = exportSummary.momPct;
  }
  const ytdBrandExports = pages.exportBrands
    ? parseRanking(
      pages.exportBrands,
      /Top automakers in China with highest NEV exports in Jan-[A-Za-z]{3} 20\d{2}/i,
      "China passenger NEV exports"
    )
    : null;
  const latestExportDestinations = pages.exportDestinations
    ? parseExportDestinations(pages.exportDestinations)
    : null;
  const exportDestinationTotal = pages.exportDestinationTotal
    ? parseExportDestinationTotal(pages.exportDestinationTotal)
    : null;
  if (latestExportDestinations) {
    latestExportDestinations.total = exportDestinationTotal?.period === latestExportDestinations.period
      ? exportDestinationTotal.value
      : null;
    latestExportDestinations.top10Total = latestExportDestinations.rows.reduce((sum, row) => sum + row.value, 0);
    latestExportDestinations.coveragePct = exportDestinationTotal
      ? latestExportDestinations.top10Total / exportDestinationTotal.value * 100
      : null;
  }

  const sourceMeta = (key, publisher, status) => pages[key] ? {
    publisher,
    url: urls[key],
    publishedAt: articlePublishedAt(pages[key], urls[key]),
    status
  } : null;
  const wholesaleYtd = pages.preliminary ? parseWholesaleYtd(pages.preliminary) : null;
  const wholesalePeriod = Object.keys(records.passengerNevWholesale || {}).sort().at(-1) || null;
  const wholesaleSource = pages.preliminary ? {
    publisher: "CPCA via CnEVPost",
    url: urls.preliminary,
    publishedAt: articlePublishedAt(pages.preliminary),
    status: "preliminary",
    tableUrl: pages.wholesale ? urls.wholesale : null,
    tablePublishedAt: pages.wholesale ? articlePublishedAt(pages.wholesale) : null,
    reportedYtd: wholesaleYtd?.value ?? null,
    reportedYtdYoyPct: wholesaleYtd?.yoyPct ?? null,
    reportedYtdPeriod: wholesaleYtd ? wholesalePeriod : null
  } : sourceMeta("wholesale", "CPCA via CnEVPost", "estimate");

  return {
    market: {
      fetchedAt: new Date().toISOString(),
      unit: "vehicles",
      months,
      series,
      latestBrandRetail,
      ytdBrandRetail,
      latestBrandExports,
      ytdBrandExports,
      latestExportDestinations,
      sources: Object.fromEntries(Object.entries({
        cpcaRetail: sourceMeta("retail", "CPCA via CnEVPost", "final"),
        cpcaWholesale: wholesaleSource,
        caam: sourceMeta("caam", "CAAM via CnEVPost", "final"),
        brandRetail: sourceMeta("brandRetail", "CPCA via CnEVPost", "final"),
        exportBrands: sourceMeta("exportBrands", "CPCA via CnEVPost", "final"),
        exportDestinations: sourceMeta("exportDestinations", urls.exportDestinations.includes("cnevpost.com") ? "CnEVPost" : "Gasgoo Automotive Research Institute", "final"),
        exportDestinationTotal: sourceMeta("exportDestinationTotal", "CPCA via Gasgoo", "final"),
        battery: sourceMeta("battery", "CABIA via CnEVPost", "final"),
        dealerInventory: sourceMeta("dealerInventory", "China Automobile Dealers Association", "final")
      }).filter(([, value]) => value)),
      definitions: marketDefinitions
    },
    errors
  };
}

function monthRange(recordMaps) {
  const keys = recordMaps.flatMap(records => Object.keys(records)).sort();
  if (!keys.length) return [];
  const start = keys[0];
  const end = keys[keys.length - 1];
  const months = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  const endYear = Number(end.slice(0, 4));
  const endMonth = Number(end.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function recordsFromSeries(months = [], values = [], options = {}) {
  const records = {};
  months.forEach((month, idx) => {
    const value = values[idx];
    if (value !== undefined && !(options.skipNull && value === null)) records[month] = value;
  });
  return records;
}

function mergeNewsSnapshots(existingData, freshData) {
  const snapshots = { ...(existingData?.news || {}) };
  for (const [brand, items] of Object.entries(freshData?.news || {})) {
    if (items.length) snapshots[brand] = latestNewsSnapshot(items);
  }
  return snapshots;
}

function periodParts(period) {
  return [...String(period || "").matchAll(/\b20\d{2}-(?:0[1-9]|1[0-2])\b/g)].map(match => match[0]);
}

function comparePeriodKeys(a, b) {
  const aParts = periodParts(a);
  const bParts = periodParts(b);
  const byEnd = String(aParts.at(-1) || "").localeCompare(String(bParts.at(-1) || ""));
  return byEnd || aParts.length - bParts.length || String(a).localeCompare(String(b));
}

function latestPeriodKey(history = {}) {
  return Object.keys(history).sort(comparePeriodKeys).at(-1);
}

function mergeSnapshotHistory(existingHistory = {}, ...snapshots) {
  const merged = { ...existingHistory };
  for (const snapshot of snapshots) {
    if (!snapshot?.period) continue;
    merged[snapshot.period] = { ...(merged[snapshot.period] || {}), ...snapshot };
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => comparePeriodKeys(a, b)));
}

function removeDuplicatePeriodAliases(history = {}) {
  const cleaned = { ...history };
  for (const [period, snapshot] of Object.entries(cleaned)) {
    const parts = periodParts(period);
    if (parts.length < 2) continue;
    const endPeriod = parts.at(-1);
    const endSnapshot = cleaned[endPeriod];
    if (endSnapshot && JSON.stringify(endSnapshot.rows || []) === JSON.stringify(snapshot.rows || [])) {
      delete cleaned[endPeriod];
    }
  }
  return Object.fromEntries(Object.entries(cleaned).sort(([a], [b]) => comparePeriodKeys(a, b)));
}

function sourceSnapshotKey(source = {}) {
  return [
    source.publishedAt || "",
    source.url || "",
    source.status || ""
  ].join("|");
}

function mergeSourceHistory(existingHistory = {}, existingSources = {}, freshSources = {}) {
  const sourceNames = [...new Set([
    ...Object.keys(existingHistory || {}),
    ...Object.keys(existingSources || {}),
    ...Object.keys(freshSources || {})
  ])];
  const history = {};
  for (const name of sourceNames) {
    const snapshots = new Map();
    const previous = Array.isArray(existingHistory?.[name]) ? existingHistory[name] : [];
    for (const source of [...previous, existingSources?.[name], freshSources?.[name]]) {
      if (!source?.url) continue;
      const key = sourceSnapshotKey(source);
      snapshots.set(key, { ...(snapshots.get(key) || {}), ...source });
    }
    history[name] = [...snapshots.values()].sort((a, b) => {
      const byDate = String(b.publishedAt || "").localeCompare(String(a.publishedAt || ""));
      return byDate || String(b.tablePublishedAt || "").localeCompare(String(a.tablePublishedAt || ""));
    });
  }
  return history;
}

function mergeMarketData(existingMarket, freshMarket) {
  if (!freshMarket?.months?.length && !existingMarket?.months?.length) return freshMarket || existingMarket || null;

  const seriesNames = [...new Set([
    ...Object.keys(existingMarket?.series || {}),
    ...Object.keys(freshMarket?.series || {})
  ])];
  const mergedRecords = {};
  for (const name of seriesNames) {
    mergedRecords[name] = {
      ...recordsFromSeries(existingMarket?.months, existingMarket?.series?.[name] || []),
      ...recordsFromSeries(freshMarket?.months, freshMarket?.series?.[name] || [], { skipNull: true })
    };
  }

  const months = monthRange(Object.values(mergedRecords));
  const series = {};
  for (const name of seriesNames) {
    series[name] = months.map(month => (
      Object.prototype.hasOwnProperty.call(mergedRecords[name], month)
        ? mergedRecords[name][month]
        : null
    ));
  }

  const brandRetailHistory = {
    latest: mergeSnapshotHistory(
      existingMarket?.brandRetailHistory?.latest,
      existingMarket?.latestBrandRetail,
      freshMarket?.latestBrandRetail
    ),
    ytd: mergeSnapshotHistory(
      existingMarket?.brandRetailHistory?.ytd,
      existingMarket?.ytdBrandRetail,
      freshMarket?.ytdBrandRetail
    )
  };
  const latestBrandPeriod = latestPeriodKey(brandRetailHistory.latest);
  const latestYtdPeriod = latestPeriodKey(brandRetailHistory.ytd);
  const exportHistory = {
    brandLatest: mergeSnapshotHistory(
      existingMarket?.exportHistory?.brandLatest,
      existingMarket?.latestBrandExports,
      freshMarket?.latestBrandExports
    ),
    brandYtd: mergeSnapshotHistory(
      existingMarket?.exportHistory?.brandYtd,
      existingMarket?.ytdBrandExports,
      freshMarket?.ytdBrandExports
    ),
    destinations: removeDuplicatePeriodAliases(mergeSnapshotHistory(
      existingMarket?.exportHistory?.destinations,
      existingMarket?.latestExportDestinations,
      freshMarket?.latestExportDestinations
    ))
  };
  const latestExportBrandPeriod = latestPeriodKey(exportHistory.brandLatest);
  const latestExportYtdPeriod = latestPeriodKey(exportHistory.brandYtd);
  const latestDestinationPeriod = latestPeriodKey(exportHistory.destinations);
  const sourceHistory = mergeSourceHistory(
    existingMarket?.sourceHistory,
    existingMarket?.sources,
    freshMarket?.sources
  );
  const currentSources = Object.fromEntries(
    Object.entries(sourceHistory).flatMap(([name, snapshots]) => snapshots[0] ? [[name, snapshots[0]]] : [])
  );

  return {
    ...(existingMarket || {}),
    ...(freshMarket || {}),
    months,
    series,
    latestBrandRetail: latestBrandPeriod ? brandRetailHistory.latest[latestBrandPeriod] : null,
    ytdBrandRetail: latestYtdPeriod ? brandRetailHistory.ytd[latestYtdPeriod] : null,
    brandRetailHistory,
    latestBrandExports: latestExportBrandPeriod ? exportHistory.brandLatest[latestExportBrandPeriod] : null,
    ytdBrandExports: latestExportYtdPeriod ? exportHistory.brandYtd[latestExportYtdPeriod] : null,
    latestExportDestinations: latestDestinationPeriod ? exportHistory.destinations[latestDestinationPeriod] : null,
    exportHistory,
    sources: currentSources,
    sourceHistory,
    definitions: { ...(existingMarket?.definitions || {}), ...(freshMarket?.definitions || {}) },
    firstFetchedAt: existingMarket?.firstFetchedAt || existingMarket?.fetchedAt || freshMarket?.fetchedAt,
    historyPolicy: "append-and-merge: monthly metrics, ranking periods, and source snapshots are retained; fresh values overwrite matching identities."
  };
}

function mergeWithExisting(freshData, existingData) {
  const newsSnapshots = mergeNewsSnapshots(existingData, freshData);
  if (!existingData?.months?.length || !existingData?.brands) {
    return {
      ...freshData,
      schemaVersion: 3,
      market: mergeMarketData(existingData?.market, freshData.market),
      news: newsSnapshots,
      firstFetchedAt: existingData?.firstFetchedAt || existingData?.fetchedAt || freshData.fetchedAt,
      historyPolicy: "append-and-merge: brand and market months, ranking periods, source snapshots, and change events are retained; news is a replaceable latest-20 snapshot."
    };
  }

  const brandNames = [...new Set([
    ...Object.keys(existingData.brands || {}),
    ...Object.keys(freshData.brands || {})
  ])];

  const mergedRecords = {};
  for (const brand of brandNames) {
    const existingRecords = recordsFromSeries(existingData.months, existingData.brands?.[brand] || []);
    const freshRecords = recordsFromSeries(freshData.months, freshData.brands?.[brand] || [], { skipNull: true });
    mergedRecords[brand] = { ...existingRecords, ...freshRecords };
  }

  const months = monthRange(Object.values(mergedRecords));
  const brands = {};
  for (const brand of brandNames) {
    brands[brand] = months.map(month => (
      Object.prototype.hasOwnProperty.call(mergedRecords[brand], month)
        ? mergedRecords[brand][month]
        : null
    ));
  }

  return {
    ...freshData,
    schemaVersion: 3,
    months,
    brands,
    market: mergeMarketData(existingData.market, freshData.market),
    news: newsSnapshots,
    newsFetchedAt: freshData.newsFetchedAt || existingData.newsFetchedAt,
    firstFetchedAt: existingData.firstFetchedAt || existingData.fetchedAt || freshData.fetchedAt,
    historyPolicy: "append-and-merge: brand and market months, ranking periods, source snapshots, and change events are retained; news is a replaceable latest-20 snapshot."
  };
}

function valuesByMonth(sourceMonths = [], values = []) {
  return Object.fromEntries(sourceMonths.map((month, index) => [month, values[index]]));
}

function summarizeSeriesChanges(items, label, oldMonths, oldValues, newMonths, newValues) {
  const oldRecords = valuesByMonth(oldMonths, oldValues);
  const newRecords = valuesByMonth(newMonths, newValues);
  for (const month of newMonths) {
    const next = newRecords[month];
    if (next == null) continue;
    const previous = oldRecords[month];
    if (previous == null) {
      items.push(`${label} ${month}: added ${next}`);
    } else if (previous !== next) {
      items.push(`${label} ${month}: revised ${previous} -> ${next}`);
    }
  }
}

function summarizeDataChanges(existingData, nextData) {
  if (!existingData) return ["Initialized dashboard data store"];
  const items = [];
  for (const [brand, values] of Object.entries(nextData.brands || {})) {
    summarizeSeriesChanges(
      items,
      `${brand} company-reported`,
      existingData.months || [],
      existingData.brands?.[brand] || [],
      nextData.months || [],
      values
    );
  }
  for (const [name, values] of Object.entries(nextData.market?.series || {})) {
    summarizeSeriesChanges(
      items,
      `Market ${name}`,
      existingData.market?.months || [],
      existingData.market?.series?.[name] || [],
      nextData.market?.months || [],
      values
    );
  }
  for (const [brand, stories] of Object.entries(nextData.news || {})) {
    const previousStories = existingData.news?.[brand] || [];
    const previousUrls = new Set(previousStories.map(item => item.url));
    const added = stories.filter(item => item.url && !previousUrls.has(item.url));
    if (added.length) items.push(`${brand} news: ${added.length} new article${added.length === 1 ? "" : "s"}`);
  }

  for (const [historyRoot, historyKey, currentKey, label] of [
    ["brandRetailHistory", "latest", "latestBrandRetail", "Monthly brand retail ranking"],
    ["brandRetailHistory", "ytd", "ytdBrandRetail", "YTD brand retail ranking"],
    ["exportHistory", "brandLatest", "latestBrandExports", "Monthly brand export ranking"],
    ["exportHistory", "brandYtd", "ytdBrandExports", "YTD brand export ranking"],
    ["exportHistory", "destinations", "latestExportDestinations", "Export destination ranking"]
  ]) {
    const previousPeriods = new Set(Object.keys(existingData.market?.[historyRoot]?.[historyKey] || {}));
    const previousCurrent = existingData.market?.[currentKey];
    if (previousCurrent?.period) previousPeriods.add(previousCurrent.period);
    for (const period of Object.keys(nextData.market?.[historyRoot]?.[historyKey] || {})) {
      if (!previousPeriods.has(period)) items.push(`${label}: added ${period}`);
    }
  }

  for (const [name, snapshots] of Object.entries(nextData.market?.sourceHistory || {})) {
    const previousSnapshots = [
      ...(existingData.market?.sourceHistory?.[name] || []),
      existingData.market?.sources?.[name]
    ].filter(Boolean);
    const previousKeys = new Set(previousSnapshots.map(sourceSnapshotKey));
    for (const snapshot of snapshots) {
      if (!previousKeys.has(sourceSnapshotKey(snapshot))) {
        items.push(`Market source ${name}: added ${snapshot.publishedAt || snapshot.url}`);
      }
    }
  }
  return items;
}

function mergeChangeHistory(existingData, changedAt, changes = []) {
  const history = [];
  const seen = new Set();
  const append = event => {
    if (!event?.changedAt || !Array.isArray(event.changes)) return;
    const key = `${event.changedAt}|${JSON.stringify(event.changes)}`;
    if (seen.has(key)) return;
    seen.add(key);
    history.push({ changedAt: event.changedAt, changes: [...event.changes] });
  };
  for (const event of existingData?.changeHistory || []) append(event);
  if (!history.length && existingData?.latestChanges?.length) {
    append({
      changedAt: existingData.lastDataChangeAt || existingData.fetchedAt,
      changes: [...existingData.latestChanges]
    });
  }
  if (changes.length) append({ changedAt, changes: [...changes] });
  return history;
}

async function readExistingData(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function scrapeData() {
  const [entries, marketResult] = await Promise.all([
    Promise.all(Object.entries(sources).map(async ([brand, url]) => {
      try {
        const html = await fetchText(url);
        const page2Url = new URL("page/2/", url).toString();
        const page2Html = await fetchText(page2Url).catch(() => "");
        const brandNews = latestNewsSnapshot(
          parseBrandNews(html, brand),
          page2Html ? parseBrandNews(page2Html, brand) : []
        );
        return [brand, parseBrandTable(html, brand), brandNews, null];
      } catch (error) {
        return [brand, null, [], `${brand}: ${error.message}`];
      }
    })),
    scrapeMarketData()
  ]);

  const errors = [
    ...entries.filter(([, records]) => records === null).map(([, , , error]) => error),
    ...marketResult.errors
  ];
  const okEntries = entries.filter(([, records]) => records !== null);
  if (!okEntries.length) throw new Error("No source could be read");

  const months = monthRange(okEntries.map(([, records]) => records));
  const brands = {};
  const news = {};
  for (const [brand, records, brandNews] of okEntries) {
    brands[brand] = months.map(month => records[month] ?? null);
    if (brandNews.length) news[brand] = brandNews;
  }

  return {
    fetchedAt: new Date().toISOString(),
    newsFetchedAt: new Date().toISOString(),
    unit: "vehicles",
    months,
    brands,
    market: marketResult.market,
    news,
    newsPolicy: { mode: "replace-snapshot", limitPerBrand: 20, sourcePages: 2, archivesOlderItems: false },
    sources,
    errors,
    assumptions: [
      "CnEVPost reports vehicles/units, not tons.",
      "Missing brand-month cells are kept as null and are not estimated.",
      "BYD uses CnEVPost NEV sales; Tesla China uses CnEVPost monthly sales including exports.",
      "Historical months already saved in china-ev-data.json are retained when CnEVPost source pages stop listing them.",
      "News is a replaceable snapshot of up to 20 latest items per brand from CnEVPost pages 1-2; older news is not archived.",
      "Company-reported brand series and China domestic retail market series are kept separate and are never summed together.",
      "When a company discloses only a threshold such as 'more than 30,000', the exact monthly value is kept null rather than estimated."
    ]
  };
}

async function main() {
  const dataPath = path.join("data", "china-ev-data.json");
  const existingData = await readExistingData(dataPath);
  let data;
  try {
    data = mergeWithExisting(await scrapeData(), existingData);
  } catch (error) {
    if (!existingData) throw error;
    data = {
      ...existingData,
      lastAttemptAt: new Date().toISOString(),
      errors: [...(existingData.errors || []), `Update skipped: ${error.message}`]
    };
    console.warn(`Keeping existing data because update failed: ${error.message}`);
  }
  const checkedAt = new Date().toISOString();
  const substantiveChanges = summarizeDataChanges(existingData, data);
  const changeHistory = mergeChangeHistory(existingData, checkedAt, substantiveChanges);
  data.lastCheckedAt = checkedAt;
  if (substantiveChanges.length) {
    data.lastDataChangeAt = checkedAt;
    data.latestChanges = substantiveChanges.slice(0, 40);
  } else {
    data.lastDataChangeAt = existingData?.lastDataChangeAt || data.fetchedAt;
    data.latestChanges = existingData?.latestChanges || [];
  }
  data.changeHistory = changeHistory;
  await fs.mkdir("data", { recursive: true });
  const jsonText = `${JSON.stringify(data, null, 2)}\n`;
  await Promise.all([
    fs.writeFile(dataPath, jsonText, "utf8"),
    fs.writeFile(path.join("data", "china-ev-data.js"), `window.CHINA_EV_DATA = ${JSON.stringify(data)};\n`, "utf8")
  ]);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `data_changed=${substantiveChanges.length ? "true" : "false"}\n`, "utf8");
    await fs.appendFile(process.env.GITHUB_OUTPUT, `source_errors=${data.errors.length}\n`, "utf8");
  }

  const total = Object.values(data.brands).flat().reduce((sum, value) => sum + (value ?? 0), 0);
  console.log(`Updated ${data.months.length} months, ${Object.keys(data.brands).length} brands, total ${total.toLocaleString("en-US")} vehicles.`);
  if (data.errors.length) {
    console.warn(data.errors.join("\n"));
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();

export {
  comparePeriodKeys,
  latestPeriodKey,
  mergeChangeHistory,
  mergeWithExisting,
  normalizedPeriodFromText,
  parseExportDestinationTotal,
  parseExportDestinations,
  parsePassengerNevExportSummary,
  parseRanking,
  summarizeDataChanges
};
