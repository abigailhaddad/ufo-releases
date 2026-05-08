/**
 * Extract text from each PDF/IMG record using an OpenAI multimodal model.
 *
 * For PDFs: render each page to PNG with `pdftoppm`, send to the model.
 * For images: send the image directly.
 *
 * Output: data/text/<id>.txt + records.json updated with textChars,
 * textExtractedAt, extractionModel.
 *
 * Idempotent: skips records whose textExtractedAt is on/after lastSeenAt
 * AND whose .txt file already exists. Force re-extract via FORCE=1.
 *
 * Env knobs:
 *   OPENAI_API_KEY  required
 *   EXTRACT_MODEL   default gpt-5.4-mini
 *   ONLY_ID         only process this record id (testing)
 *   LIMIT           cap on records processed this run
 *   MAX_PAGES       cap on pages per PDF (default 30)
 *   CONCURRENCY     parallel page calls per PDF (default 4)
 *   FORCE=1         re-extract even if cached
 */
import OpenAI from "openai";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_PATH = path.join(process.cwd(), "data", "records.json");
const TEXT_DIR = path.join(process.cwd(), "data", "text");
const MODEL = process.env.EXTRACT_MODEL ?? "gpt-5.5";
const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? "30", 10);
const RENDER_DPI = parseInt(process.env.RENDER_DPI ?? "200", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "4", 10);
const RECORD_CONCURRENCY = parseInt(process.env.RECORD_CONCURRENCY ?? "1", 10);
const ONLY_ID = process.env.ONLY_ID ? parseInt(process.env.ONLY_ID, 10) : null;
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const FORCE = process.env.FORCE === "1";

type StoredRecord = {
  id: number;
  title: string;
  type: string;
  fileUrl: string;
  removedFromSource?: boolean;
  lastSeenAt?: string;
  textChars?: number;
  textExtractedAt?: string;
  extractionModel?: string;
  extractionPages?: number;
  extractionError?: string | null;
};

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY not set. Put it in .env (gitignored).");
  process.exit(1);
}
const client = new OpenAI();

const PROMPT_PAGE =
  "Transcribe text from this scanned document page. Strict rules:\n" +
  "- Transcribe ONLY what you can clearly read. Never guess.\n" +
  "- For any word, phrase, or region you are not confident about, write [illegible] or [unclear: best guess?].\n" +
  "- Never repeat a word out of uncertainty (e.g. do NOT write 'the the the' or 'His His His'). " +
  "If you see what looks like a repeated word, transcribe it once, or use [illegible] if you can't tell.\n" +
  "- Preserve paragraph breaks and original line breaks where reasonable.\n" +
  "- Include headers, footers, page numbers, stamps, signatures, marginalia, and crossed-out text " +
  "(mark the latter with [strikethrough: ...]).\n" +
  "- For handwritten content, prefer [illegible] over a wrong reading.\n" +
  "- If the page is blank, output exactly: [blank page].\n" +
  "- Do not summarize, paraphrase, or add commentary. Output only the transcription.";

const PROMPT_IMAGE =
  "Transcribe any visible text in this image verbatim, then add one short factual " +
  "sentence describing what is depicted (subject, setting, notable features). " +
  "Do not speculate beyond what is visible.";

function extOf(url: string): string {
  return (url.split("?")[0].split(".").pop() ?? "").toLowerCase();
}

async function downloadFile(url: string, dest: string) {
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      Referer: "https://www.war.gov/UFO/",
    },
  });
  if (!r.ok) throw new Error(`download ${url} -> HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function transcribePage(imagePath: string, prompt: string): Promise<string> {
  const buf = fs.readFileSync(imagePath);
  const b64 = buf.toString("base64");
  const resp = await client.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${b64}`, detail: "high" },
          },
        ],
      },
    ],
  });
  return resp.choices[0]?.message?.content ?? "";
}

async function pmap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function extractFromPdf(url: string, recordId: number) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ufo-${recordId}-`));
  try {
    const pdfPath = path.join(tmpDir, "doc.pdf");
    await downloadFile(url, pdfPath);
    execFileSync(
      "pdftoppm",
      [
        "-png",
        "-r",
        String(RENDER_DPI),
        "-l",
        String(MAX_PAGES),
        pdfPath,
        path.join(tmpDir, "page"),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const pages = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort();
    if (pages.length === 0) throw new Error("pdftoppm produced no pages");

    const transcripts = await pmap(pages, CONCURRENCY, (page) =>
      transcribePage(path.join(tmpDir, page), PROMPT_PAGE),
    );

    const text = transcripts
      .map((t, i) => `--- PAGE ${i + 1} ---\n${t.trim()}`)
      .join("\n\n");
    return { text, pages: pages.length };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function extractFromImage(url: string, recordId: number) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ufo-${recordId}-`));
  try {
    const ext = extOf(url) || "jpg";
    const imgPath = path.join(tmpDir, `img.${ext}`);
    await downloadFile(url, imgPath);
    const text = await transcribePage(imgPath, PROMPT_IMAGE);
    return { text, pages: 1 };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function shouldSkip(r: StoredRecord, textPath: string): boolean {
  if (FORCE) return false;
  if (!fs.existsSync(textPath)) return false;
  if (!r.textExtractedAt) return false;
  // Re-extract if we're running a different model than the saved one — quality
  // upgrade should be reflected in the cache.
  if (r.extractionModel && r.extractionModel !== MODEL) return false;
  if (!r.lastSeenAt) return true;
  return r.textExtractedAt >= r.lastSeenAt;
}

async function main() {
  fs.mkdirSync(TEXT_DIR, { recursive: true });
  const records: StoredRecord[] = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

  // Pick targets up-front so parallel workers don't double-claim records.
  const targets: StoredRecord[] = [];
  for (const r of records) {
    if (targets.length >= LIMIT) break;
    if (ONLY_ID !== null && r.id !== ONLY_ID) continue;
    if (r.removedFromSource) continue;
    if (!r.fileUrl) continue;
    const ext = extOf(r.fileUrl);
    if (ext !== "pdf" && ext !== "png" && ext !== "jpg" && ext !== "jpeg") continue;
    if (shouldSkip(r, path.join(TEXT_DIR, `${r.id}.txt`))) continue;
    targets.push(r);
  }

  console.log(
    `Targets: ${targets.length} records · model=${MODEL} · dpi=${RENDER_DPI} · ` +
      `record-concurrency=${RECORD_CONCURRENCY} · page-concurrency=${CONCURRENCY}`,
  );

  let processed = 0;
  let failed = 0;
  let saving = Promise.resolve();
  function persist() {
    // Serialize writes so we never tear records.json with concurrent writes.
    saving = saving.then(() => {
      fs.writeFileSync(DATA_PATH, JSON.stringify(records, null, 2) + "\n");
    });
    return saving;
  }

  await pmap(targets, RECORD_CONCURRENCY, async (r) => {
    const today = new Date().toISOString().slice(0, 10);
    const label = `#${r.id} ${r.title.slice(0, 60)}`;
    const ext = extOf(r.fileUrl);
    const isPdf = ext === "pdf";
    const t0 = Date.now();
    try {
      const { text, pages } = isPdf
        ? await extractFromPdf(r.fileUrl, r.id)
        : await extractFromImage(r.fileUrl, r.id);
      fs.writeFileSync(path.join(TEXT_DIR, `${r.id}.txt`), text);
      r.textChars = text.length;
      r.extractionPages = pages;
      r.textExtractedAt = today;
      r.extractionModel = MODEL;
      r.extractionError = null;
      processed += 1;
      console.log(
        `${label} → ${pages}p, ${text.length}ch, ${Math.round((Date.now() - t0) / 1000)}s`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      r.extractionError = msg;
      failed += 1;
      console.log(`${label} FAIL ${msg}`);
    }
    await persist();
  });

  await saving;
  console.log(`\nDone. Processed ${processed}, failed ${failed}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
