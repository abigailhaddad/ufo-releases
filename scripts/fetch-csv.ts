/**
 * Pull the war.gov UFO record CSV, merge into data/records.json.
 *
 * Merge rules (per user spec):
 *   - Records present in source are upserted (right-side wins on overlap).
 *   - Records that disappear from source are KEPT and flagged removedFromSource=true.
 *   - firstSeenAt is tracked per record. lastSeenAt is only stored once a record
 *     LEAVES the source, frozen at the last refresh that still saw it — for live
 *     records it would just be today's date on every row, which rewrote all ~376
 *     records daily and made the git history useless. "Live as of" now lives in
 *     data/refresh-meta.json instead.
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
// war.gov renamed the CSV from uap-csv.csv → uap-releaseNNN.csv on
// 2026-05-12. Rather than chase the version suffix, discover the path from
// the page each run. These fallbacks let us hand-pin a path in CI if the
// scrape ever fails.
const CSV_PATH_FALLBACKS = [
  "/Portals/1/Interactive/2026/UFO/uap-release001.csv",
  "/Portals/1/Interactive/2026/UFO/uap-csv.csv",
];
const DATA_DIR = path.join(process.cwd(), "data");
const DATA_PATH = path.join(DATA_DIR, "records.json");
const RAW_CSV_PATH = path.join(DATA_DIR, "uap-csv.csv");
const META_PATH = path.join(DATA_DIR, "refresh-meta.json");

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
  contentHash?: string;
};

function clean(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

// "N/A" is a meaningful display value in Incident Date/Location, but in the
// URL and DVIDS-id columns it's a missing-data placeholder that breaks the
// verify-data URL check. Drop it for those fields only.
function cleanPlaceholder(s: string | undefined): string {
  const v = clean(s);
  return /^n\/?a$/i.test(v) ? "" : v;
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
    fileUrl: cleanPlaceholder(row["PDF | Image Link"]),
    thumbnailUrl: cleanPlaceholder(row["Modal Image"]),
    dvidsVideoId: cleanPlaceholder(row["DVIDS Video ID"]),
    videoTitle: clean(row["Video Title"]),
    videoPairing: clean(row["Video Pairing"]),
    pdfPairing: clean(row["PDF Pairing"]),
    redaction: clean(row.Redaction),
  };
}

// war.gov assigns each release a stable ID embedded at the start of its title,
// e.g. "DOW-UAP-PR026, ...". Match an agency code + "-UAP-" + a record number
// that may carry a letter suffix (PR057a) or none (CIA-UAP-017).
const RECORD_ID_RE = /[A-Z]{2,5}-UAP-[A-Za-z0-9]+/i;

function recordKey(r: {
  title: string;
  agency: string;
  type: string;
  fileUrl?: string;
  dvidsVideoId?: string;
}) {
  // Prefer the most stable identifier in the source. The embedded record ID is
  // the most durable: it survives display-title edits (war.gov renamed "Persian
  // Gulf" → "Arabian Gulf" on several records without touching the ID) AND stays
  // unique when several records share a single file — e.g. the PR026/PR027
  // "Unresolved UAP Report" entries both link the same mission-report PDF, so
  // keying on the URL alone silently collapses them into one. Fall back to the
  // file URL, then DVIDS id, then the raw title.
  const idMatch = r.title.match(RECORD_ID_RE);
  const stable =
    (idMatch && `id:${idMatch[0].toLowerCase()}`) ||
    (r.fileUrl && r.fileUrl.toLowerCase()) ||
    (r.dvidsVideoId && `dvids:${r.dvidsVideoId}`) ||
    `title:${r.title.toLowerCase()}`;
  return `${r.agency}::${r.type}::${stable}`;
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

    // Discover the CSV link from the page so version bumps (uap-release001 →
    // 002 etc.) don't break us. The sandbox/testing CSV on a different host
    // shows up too — filter to the UFO portals path.
    const html = await page.content();
    const discovered = Array.from(html.matchAll(/\/Portals\/[\w./\-?=&%]*?\.csv/gi))
      .map((m) => m[0])
      .filter((u) => /\/UFO\//i.test(u));
    const candidates = [...new Set([...discovered, ...CSV_PATH_FALLBACKS])];

    let lastErr: unknown;
    for (const csvPath of candidates) {
      try {
        const text = await page.evaluate(async (p) => {
          const r = await fetch(p, { credentials: "include", cache: "no-store" });
          if (!r.ok) throw new Error(`fetch ${p} -> HTTP ${r.status}`);
          return await r.text();
        }, csvPath);
        if (text && text.includes(",")) {
          console.log(`Resolved CSV path: ${csvPath}`);
          return text;
        }
        lastErr = new Error(`CSV at ${csvPath} looked empty`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error("no CSV candidate succeeded");
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

  // The refresh that last saw everything still live. A record that drops out of
  // the source this run was last seen then, not today.
  let prevRefreshedAt = today;
  if (fs.existsSync(META_PATH)) {
    const meta = JSON.parse(fs.readFileSync(META_PATH, "utf8")) as { lastRefreshedAt?: string };
    if (meta.lastRefreshedAt) prevRefreshedAt = meta.lastRefreshedAt;
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
      // Still live: drop any stale lastSeenAt so the row stops changing daily.
      const { lastSeenAt: _dropped, ...rest } = prev;
      merged.push({
        ...rest,
        ...fresh,
        firstSeenAt: prev.firstSeenAt ?? today,
        removedFromSource: false,
      });
      updates += 1;
    } else {
      const wasRemoved = prev.removedFromSource ?? false;
      merged.push({
        ...prev,
        firstSeenAt: prev.firstSeenAt ?? prev.releaseDate ?? today,
        // Freeze on the live → removed transition; never move it afterwards.
        lastSeenAt: wasRemoved ? prev.lastSeenAt : (prev.lastSeenAt ?? prevRefreshedAt),
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

  // One line moves per day instead of one per record. Any record without
  // removedFromSource was present in the source as of lastRefreshedAt.
  fs.writeFileSync(
    META_PATH,
    JSON.stringify(
      {
        lastRefreshedAt: today,
        liveRecords: merged.filter((r) => !r.removedFromSource).length,
        archivedRecords: merged.filter((r) => r.removedFromSource).length,
      },
      null,
      2,
    ) + "\n",
  );

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
