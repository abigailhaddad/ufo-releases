/**
 * Pre-download all war.gov PDFs to data/_pdfs/<id>.pdf using a stealth-patched
 * Chromium so Akamai sees a real browser. Akamai gives plain HTTP clients 403
 * once it spots volume from one IP, so we route every PDF through the page
 * context that already cleared Akamai's bot challenge for war.gov/UFO.
 *
 * Idempotent: skips files already on disk. Sequential to be polite to Akamai.
 */
import { chromium as rawChromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const chromium = rawChromium;
chromium.use(StealthPlugin());

const SOURCE_PAGE = "https://www.war.gov/UFO/";
const DATA_PATH = path.join(process.cwd(), "data", "records.json");
const OUT_DIR = path.join(process.cwd(), "data", "_pdfs");

type StoredRecord = {
  id: number;
  title: string;
  type: string;
  fileUrl: string;
  removedFromSource?: boolean;
  contentHash?: string;
  [k: string]: unknown;
};

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function persist(records: StoredRecord[]): void {
  fs.writeFileSync(DATA_PATH, JSON.stringify(records, null, 2) + "\n");
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const records: StoredRecord[] = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  let dirty = false;

  // Backfill: hash any PDF already on disk that lacks a contentHash. This
  // covers historical records (including archived ones) and lets the dedup
  // step find rename pairs without re-downloading.
  let backfilled = 0;
  for (const r of records) {
    if (r.contentHash) continue;
    if (r.type !== "PDF") continue;
    const local = path.join(OUT_DIR, `${r.id}.pdf`);
    if (!fs.existsSync(local)) continue;
    r.contentHash = sha256(fs.readFileSync(local));
    backfilled += 1;
    dirty = true;
  }
  if (backfilled > 0) {
    console.log(`Backfilled contentHash for ${backfilled} existing PDF(s).`);
    persist(records);
  }

  const targets = records.filter(
    (r) =>
      r.type === "PDF" &&
      !r.removedFromSource &&
      r.fileUrl &&
      !fs.existsSync(path.join(OUT_DIR, `${r.id}.pdf`)),
  );

  if (targets.length === 0) {
    if (!dirty) console.log("All PDFs already downloaded.");
    return;
  }

  console.log(`Downloading ${targets.length} PDFs to ${OUT_DIR}…`);

  const browser = await chromium.launch({
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await ctx.newPage();

    console.log("Visiting war.gov/UFO/ to clear Akamai…");
    await page.goto(SOURCE_PAGE, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page
      .waitForFunction(() => /bm_sz=|ak_bmsc=/.test(document.cookie || ""), undefined, {
        timeout: 30_000,
      })
      .catch(() => undefined);
    console.log("Akamai cookies set.");

    let done = 0;
    let failed = 0;
    for (const r of targets) {
      const dest = path.join(OUT_DIR, `${r.id}.pdf`);
      const t0 = Date.now();
      process.stdout.write(`#${r.id} ${r.title.slice(0, 60).padEnd(62)} … `);
      try {
        // Fetch from inside the browser page context (same fingerprint that
        // cleared the bot challenge). Stream bytes back as a base64 string —
        // smaller bridge cost than a numeric array, and large PDFs survive.
        const b64 = await page.evaluate(async (url) => {
          const r = await fetch(url, { credentials: "include", cache: "no-store" });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const buf = new Uint8Array(await r.arrayBuffer());
          let s = "";
          const chunk = 0x8000;
          for (let i = 0; i < buf.length; i += chunk) {
            s += String.fromCharCode.apply(
              null,
              Array.from(buf.subarray(i, i + chunk)),
            );
          }
          return btoa(s);
        }, r.fileUrl);
        const buf = Buffer.from(b64, "base64");
        fs.writeFileSync(dest, buf);
        r.contentHash = sha256(buf);
        dirty = true;
        done += 1;
        console.log(
          `${(buf.length / 1024 / 1024).toFixed(1)} MB, ${Math.round((Date.now() - t0) / 1000)}s`,
        );
      } catch (err) {
        failed += 1;
        console.log(`FAIL ${(err as Error).message}`);
      }
    }
    console.log(`\nDone. Downloaded ${done}, failed ${failed}.`);
    if (dirty) persist(records);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
