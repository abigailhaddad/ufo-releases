/**
 * Pull the war.gov UFO record CSV, merge into data/records.json.
 *
 * Merge rules (per user spec):
 *   - Records present in source are upserted (right-side wins on overlap).
 *   - Records that disappear from source are KEPT and flagged removedFromSource=true.
 *   - First/last-seen dates are tracked per record.
 *
 * Akamai blocks plain HTTP clients, so we drive a real Chromium via Playwright.
 */
import { chromium as rawChromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { parse } from "csv-parse/sync";
import fs from "node:fs";
import path from "node:path";

const chromium = rawChromium;
chromium.use(StealthPlugin());

const SOURCE_PAGE = "https://www.war.gov/UFO/";
const CSV_PATH = "/Portals/1/Interactive/2026/UFO/uap-csv.csv";
const DATA_DIR = path.join(process.cwd(), "data");
const DATA_PATH = path.join(DATA_DIR, "records.json");
const RAW_CSV_PATH = path.join(DATA_DIR, "uap-csv.csv");

type CsvRow = Record<string, string>;

type StoredRecord = {
  id: number;
  title: string;
  type: string;
  agency: string;
  releaseDate: string;
  incidentDate: string;
  incidentLocation: string;
  description: string;
  fileUrl: string;
  thumbnailUrl: string;
  dvidsVideoId: string;
  videoTitle: string;
  videoPairing: string;
  pdfPairing: string;
  redaction: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  removedFromSource?: boolean;
};

function clean(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function rowToRecord(row: CsvRow) {
  return {
    title: clean(row.Title),
    type: clean(row.Type),
    agency: clean(row.Agency),
    releaseDate: clean(row["Release Date"]),
    incidentDate: clean(row["Incident Date"]),
    incidentLocation: clean(row["Incident Location"]),
    description: clean(row["Description Blurb"]),
    fileUrl: clean(row["PDF | Image Link"]),
    thumbnailUrl: clean(row["Modal Image"]),
    dvidsVideoId: clean(row["DVIDS Video ID"]),
    videoTitle: clean(row["Video Title"]),
    videoPairing: clean(row["Video Pairing"]),
    pdfPairing: clean(row["PDF Pairing"]),
    redaction: clean(row.Redaction),
  };
}

function recordKey(r: { title: string; agency: string; type: string }) {
  return `${r.agency}::${r.type}::${r.title.toLowerCase()}`;
}

async function fetchCsv(): Promise<string> {
  const browser = await chromium.launch({
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });
  try {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    // Hide the obvious webdriver giveaway before any page script runs.
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await ctx.newPage();
    await page.goto(SOURCE_PAGE, { waitUntil: "domcontentloaded", timeout: 90_000 });
    // Akamai sets bm_sz / ak_bmsc once it's satisfied; wait for it.
    await page
      .waitForFunction(() => /bm_sz=|ak_bmsc=/.test(document.cookie || ""), undefined, {
        timeout: 30_000,
      })
      .catch(() => undefined);
    // Issue the fetch from inside the page — same fingerprint Akamai already cleared.
    const text = await page.evaluate(async (csvPath) => {
      const r = await fetch(csvPath, { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`fetch ${csvPath} -> HTTP ${r.status}`);
      return await r.text();
    }, CSV_PATH);
    if (!text || !text.includes(",")) throw new Error("CSV looked empty");
    return text;
  } finally {
    await browser.close();
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  console.log("Fetching CSV from war.gov…");
  const csvText = await fetchCsv();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RAW_CSV_PATH, csvText);

  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as CsvRow[];

  const fetched = rows.map(rowToRecord).filter((r) => r.title || r.fileUrl || r.dvidsVideoId);
  console.log(`Parsed ${fetched.length} records from source.`);

  let existing: StoredRecord[] = [];
  if (fs.existsSync(DATA_PATH)) {
    existing = JSON.parse(fs.readFileSync(DATA_PATH, "utf8")) as StoredRecord[];
  }

  const fetchedByKey = new Map(fetched.map((r) => [recordKey(r), r]));
  const merged: StoredRecord[] = [];
  let nextId = existing.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const handledKeys = new Set<string>();

  let updates = 0;
  let removals = 0;
  let additions = 0;

  for (const prev of existing) {
    const key = recordKey(prev);
    handledKeys.add(key);
    const fresh = fetchedByKey.get(key);
    if (fresh) {
      merged.push({
        ...prev,
        ...fresh,
        firstSeenAt: prev.firstSeenAt ?? today,
        lastSeenAt: today,
        removedFromSource: false,
      });
      updates += 1;
    } else {
      const wasRemoved = prev.removedFromSource ?? false;
      merged.push({
        ...prev,
        firstSeenAt: prev.firstSeenAt ?? prev.releaseDate ?? today,
        lastSeenAt: prev.lastSeenAt ?? today,
        removedFromSource: true,
      });
      if (!wasRemoved) removals += 1;
    }
  }

  for (const fresh of fetched) {
    const key = recordKey(fresh);
    if (handledKeys.has(key)) continue;
    merged.push({
      id: nextId++,
      ...fresh,
      firstSeenAt: today,
      lastSeenAt: today,
      removedFromSource: false,
    });
    additions += 1;
  }

  merged.sort((a, b) => a.id - b.id);
  fs.writeFileSync(DATA_PATH, JSON.stringify(merged, null, 2) + "\n");

  console.log("--- Refresh summary ---");
  console.log(`Total records (incl. archived): ${merged.length}`);
  console.log(`Currently live in source:       ${merged.filter((r) => !r.removedFromSource).length}`);
  console.log(`Archived (gone from source):    ${merged.filter((r) => r.removedFromSource).length}`);
  console.log(`New this run:                   ${additions}`);
  console.log(`Newly removed this run:         ${removals}`);
  console.log(`Existing rows refreshed:        ${updates}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
