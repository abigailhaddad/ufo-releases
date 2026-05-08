/**
 * Download IMG (war.gov-hosted) and VID (DVIDS-hosted) records to data/_media/.
 *
 * Mirrors the Python alternative scripts/download_ufo_files.py — same DVIDS
 * embed-URL trick — but uses our existing Playwright stealth stack instead of
 * Selenium so it fits the rest of the pipeline.
 *
 * - IMG records: war.gov has them behind the same Akamai bot challenge as PDFs.
 *   Same approach as download-pdfs.ts — fetch from inside the page context that
 *   already cleared the challenge.
 *
 * - VID records: DVIDS now requires login for /download/videofile/<id>. The
 *   embed iframe at /video/embed/<id> still serves a public CloudFront .mp4
 *   URL inline in the HTML. We scrape that URL and download it.
 *
 * Idempotent: skips files already on disk.
 */
import { chromium as rawChromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "node:fs";
import path from "node:path";

const chromium = rawChromium;
chromium.use(StealthPlugin());

const SOURCE_PAGE = "https://www.war.gov/UFO/";
const DVIDS_BASE = "https://www.dvidshub.net";
const DATA_PATH = path.join(process.cwd(), "data", "records.json");
const OUT_DIR = path.join(process.cwd(), "data", "_media");

type StoredRecord = {
  id: number;
  title: string;
  type: string;
  fileUrl: string;
  dvidsVideoId: string;
  removedFromSource?: boolean;
};

function extOf(url: string): string {
  const clean = url.split("?")[0];
  const ext = path.extname(clean).slice(1).toLowerCase();
  return ext || "bin";
}

async function fetchInPageBase64(
  page: import("playwright-core").Page,
  url: string,
): Promise<Buffer> {
  const b64 = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include", cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + chunk)));
    }
    return btoa(s);
  }, url);
  return Buffer.from(b64, "base64");
}

async function fetchViaContextRequest(
  ctx: import("playwright-core").BrowserContext,
  url: string,
): Promise<Buffer> {
  const resp = await ctx.request.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "*/*",
    },
    timeout: 120_000,
  });
  if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
  return Buffer.from(await resp.body());
}

async function findMp4FromEmbed(
  page: import("playwright-core").Page,
  videoId: string,
): Promise<string> {
  const embedUrl = `${DVIDS_BASE}/video/embed/${videoId}`;
  await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const html = await page.content();
  const m = html.match(/https?:\/\/[^"' ]+\.mp4[^"' ]*/);
  if (!m) throw new Error("no .mp4 URL in DVIDS embed HTML");
  return m[0];
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const records: StoredRecord[] = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

  const imgs = records.filter(
    (r) => r.type === "IMG" && r.fileUrl && !r.removedFromSource,
  );
  const vids = records.filter(
    (r) => r.type === "VID" && r.dvidsVideoId && !r.removedFromSource,
  );
  const todo = [...imgs, ...vids];

  console.log(`Targets: ${imgs.length} images + ${vids.length} videos = ${todo.length}`);

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

    let done = 0;
    let failed = 0;
    let skipped = 0;
    for (const r of todo) {
      const isVideo = r.type === "VID";
      const ext = isVideo ? "mp4" : extOf(r.fileUrl);
      const dest = path.join(OUT_DIR, `${r.id}.${ext}`);
      if (fs.existsSync(dest)) {
        skipped += 1;
        continue;
      }
      const t0 = Date.now();
      const label = `#${r.id} ${r.type} ${r.title.slice(0, 55).padEnd(57)}`;
      process.stdout.write(`${label} … `);
      try {
        let url = r.fileUrl;
        if (isVideo) {
          // Get the public CloudFront mp4 URL from the embed iframe
          url = await findMp4FromEmbed(page, r.dvidsVideoId);
          // Re-clear war.gov Akamai cookies on the page (we navigated away).
          // Actually we don't need that for CloudFront — different host. Just fetch.
        }
        const buf = await fetchInPageBase64(page, url);
        fs.writeFileSync(dest, buf);
        done += 1;
        console.log(
          `${(buf.length / 1024 / 1024).toFixed(1)} MB, ${Math.round((Date.now() - t0) / 1000)}s`,
        );
      } catch (err) {
        failed += 1;
        console.log(`FAIL ${(err as Error).message}`);
      }
    }
    console.log(
      `\nDone. Downloaded ${done}, skipped ${skipped} (already present), failed ${failed}.`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
