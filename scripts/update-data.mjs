import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";

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
    .trim();
}

function numberFromCell(value) {
  const text = cleanCell(value);
  if (!text) return null;
  const normalized = text.replace(/,/g, "");
  if (!/^\d+$/.test(normalized)) return null;
  return Number(normalized);
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

function recordsFromSeries(months = [], values = []) {
  const records = {};
  months.forEach((month, idx) => {
    const value = values[idx];
    if (value !== undefined) records[month] = value;
  });
  return records;
}

function mergeWithExisting(freshData, existingData) {
  if (!existingData?.months?.length || !existingData?.brands) return freshData;

  const brandNames = [...new Set([
    ...Object.keys(existingData.brands || {}),
    ...Object.keys(freshData.brands || {})
  ])];

  const mergedRecords = {};
  for (const brand of brandNames) {
    const existingRecords = recordsFromSeries(existingData.months, existingData.brands?.[brand] || []);
    const freshRecords = recordsFromSeries(freshData.months, freshData.brands?.[brand] || []);
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
    months,
    brands,
    firstFetchedAt: existingData.firstFetchedAt || existingData.fetchedAt || freshData.fetchedAt,
    historyPolicy: "append-and-merge: existing months are retained; fresh CnEVPost values overwrite matching brand-month cells."
  };
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
  const entries = await Promise.all(Object.entries(sources).map(async ([brand, url]) => {
    try {
      const html = await fetchText(url);
      return [brand, parseBrandTable(html, brand), null];
    } catch (error) {
      return [brand, null, `${brand}: ${error.message}`];
    }
  }));

  const errors = entries.filter(([, records]) => records === null).map(([, , error]) => error);
  const okEntries = entries.filter(([, records]) => records !== null);
  if (!okEntries.length) throw new Error("No source could be read");

  const months = monthRange(okEntries.map(([, records]) => records));
  const brands = {};
  for (const [brand, records] of okEntries) {
    brands[brand] = months.map(month => records[month] ?? null);
  }

  return {
    fetchedAt: new Date().toISOString(),
    unit: "vehicles",
    months,
    brands,
    sources,
    errors,
    assumptions: [
      "CnEVPost reports vehicles/units, not tons.",
      "Missing brand-month cells are kept as null and are not estimated.",
      "BYD uses CnEVPost NEV sales; Tesla China uses CnEVPost monthly sales including exports.",
      "Historical months already saved in china-ev-data.json are retained when CnEVPost source pages stop listing them."
    ]
  };
}

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
await fs.mkdir("data", { recursive: true });
await fs.writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

const total = Object.values(data.brands).flat().reduce((sum, value) => sum + (value ?? 0), 0);
console.log(`Updated ${data.months.length} months, ${Object.keys(data.brands).length} brands, total ${total.toLocaleString("en-US")} vehicles.`);
if (data.errors.length) {
  console.warn(data.errors.join("\n"));
}
