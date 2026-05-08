/**
 * Gemini-based PDF text extractor. Used for records pdftotext can't handle.
 *
 * - Reads local PDFs from data/_pdfs/<id>.pdf (downloaded by download-pdfs.ts)
 * - Renders pages with pdftoppm at RENDER_DPI
 * - Transcribes each page with the Gemini model (default gemini-2.5-flash)
 * - Writes data/text/<id>.txt and updates records.json
 *
 * Skips records already extracted unless FORCE=1.
 *
 * Env:
 *   GOOGLE_API_KEY       required
 *   GEMINI_MODEL         default gemini-2.5-flash
 *   LIMIT                cap records this run
 *   ONLY_ID              one record only
 *   ONLY_AGENCY          filter by agency
 *   SKIP_AGENCY          exclude an agency
 *   RECORD_CONCURRENCY   parallel records (default 1; bump if quota allows)
 *   CONCURRENCY          parallel pages per record (default 4)
 *   RENDER_DPI           default 200
 *   MAX_PAGES            cap pages per record (default 30)
 */
import { GoogleGenAI } from "@google/genai";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_PATH = path.join(process.cwd(), "data", "records.json");
const TEXT_DIR = path.join(process.cwd(), "data", "text");
const PDF_DIR = path.join(process.cwd(), "data", "_pdfs");
const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const RENDER_DPI = parseInt(process.env.RENDER_DPI ?? "200", 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? "30", 10);
const PAGE_CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "4", 10);
const RECORD_CONCURRENCY = parseInt(process.env.RECORD_CONCURRENCY ?? "1", 10);
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const ONLY_ID = process.env.ONLY_ID ? parseInt(process.env.ONLY_ID, 10) : null;
const ONLY_AGENCY = process.env.ONLY_AGENCY ?? "";
const SKIP_AGENCY = process.env.SKIP_AGENCY ?? "";
const FORCE = process.env.FORCE === "1";

if (!process.env.GOOGLE_API_KEY) {
  console.error("GOOGLE_API_KEY not set in .env");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

const PROMPT_PAGE =
  "Transcribe text from this scanned document page. Strict rules:\n" +
  "- Transcribe ONLY what you can clearly read. Never guess.\n" +
  "- For any word, phrase, or region you are not confident about, write [illegible] or [unclear: best guess?].\n" +
  "- Never repeat a word out of uncertainty.\n" +
  "- Preserve paragraph breaks and original line breaks where reasonable.\n" +
  "- Include headers, footers, page numbers, stamps (e.g. [stamp: ANSWERED]), signatures, marginalia, and crossed-out text (mark the latter with [strikethrough: ...]).\n" +
  "- For handwritten content, prefer [illegible] over a wrong reading.\n" +
  "- If the page is blank, output exactly: [blank page].\n" +
  "- Do not summarize, paraphrase, or add commentary. Output only the transcription.";

type StoredRecord = {
  id: number;
  title: string;
  type: string;
  agency: string;
  fileUrl: string;
  removedFromSource?: boolean;
  textChars?: number;
  extractionPages?: number;
  textExtractedAt?: string;
  extractionModel?: string;
  extractionError?: string | null;
};

async function transcribePage(pngPath: string): Promise<string> {
  const buf = fs.readFileSync(pngPath);
  const max = 6;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/png", data: buf.toString("base64") } },
              { text: PROMPT_PAGE },
            ],
          },
        ],
      });
      return resp.text ?? "";
    } catch (err) {
      const msg = ((err as Error).message ?? "").toLowerCase();
      const transient =
        msg.includes("429") ||
        msg.includes("resource_exhausted") ||
        msg.includes("quota") ||
        msg.includes("internal") ||
        msg.includes("unavailable") ||
        msg.includes("deadline") ||
        msg.includes("connection");
      if (!transient || attempt === max) throw err;
      const m = msg.match(/retry in ([\d.]+)s/);
      const delayMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 1000 : 2000 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("transcribePage: retries exhausted");
}

async function pmap<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function processRecord(r: StoredRecord) {
  const localPdf = path.join(PDF_DIR, `${r.id}.pdf`);
  if (!fs.existsSync(localPdf)) {
    throw new Error(`no local PDF at ${localPdf} (run pnpm download:pdfs)`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ufo-gem-${r.id}-`));
  try {
    execFileSync(
      "pdftoppm",
      [
        "-png",
        "-r",
        String(RENDER_DPI),
        "-l",
        String(MAX_PAGES),
        localPdf,
        path.join(tmpDir, "page"),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const pages = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort();
    if (pages.length === 0) throw new Error("pdftoppm produced no pages");
    const transcripts = await pmap(pages, PAGE_CONCURRENCY, (p) =>
      transcribePage(path.join(tmpDir, p)),
    );
    const text = transcripts.map((t, i) => `--- PAGE ${i + 1} ---\n${t.trim()}`).join("\n\n");
    return { text, pages: pages.length };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(TEXT_DIR, { recursive: true });
  const records: StoredRecord[] = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

  const targets: StoredRecord[] = [];
  for (const r of records) {
    if (targets.length >= LIMIT) break;
    if (ONLY_ID !== null && r.id !== ONLY_ID) continue;
    if (ONLY_AGENCY && r.agency !== ONLY_AGENCY) continue;
    if (SKIP_AGENCY && r.agency === SKIP_AGENCY) continue;
    if (r.removedFromSource) continue;
    if (r.type !== "PDF") continue;
    if (!r.fileUrl) continue;
    if (!FORCE && r.extractionModel) continue;
    targets.push(r);
  }

  console.log(
    `Targets: ${targets.length} records · model=${MODEL} · dpi=${RENDER_DPI} · ` +
      `record-concurrency=${RECORD_CONCURRENCY} · page-concurrency=${PAGE_CONCURRENCY}`,
  );

  let processed = 0;
  let failed = 0;
  let saving = Promise.resolve();
  function persist() {
    saving = saving.then(() => {
      fs.writeFileSync(DATA_PATH, JSON.stringify(records, null, 2) + "\n");
    });
    return saving;
  }

  await pmap(targets, RECORD_CONCURRENCY, async (r) => {
    const today = new Date().toISOString().slice(0, 10);
    const label = `#${r.id} ${r.title.slice(0, 60)}`;
    const t0 = Date.now();
    try {
      const { text, pages } = await processRecord(r);
      fs.writeFileSync(path.join(TEXT_DIR, `${r.id}.txt`), text);
      r.textChars = text.length;
      r.extractionPages = pages;
      r.textExtractedAt = today;
      r.extractionModel = MODEL;
      r.extractionError = null;
      processed += 1;
      console.log(
        `${label} → ${MODEL} ${pages}p, ${text.length}ch, ${Math.round((Date.now() - t0) / 1000)}s`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      r.extractionError = msg;
      failed += 1;
      console.log(`${label} FAIL ${msg.slice(0, 120)}`);
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
