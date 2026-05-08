/**
 * Apples-to-apples comparison run: render PDF pages exactly like the OpenAI
 * pipeline (pdftoppm 200 DPI), then send each PNG to Gemini.
 *
 * Writes to data/text-gemini/<id>.txt so we can diff vs data/text/<id>.txt.
 *
 * Env: GOOGLE_API_KEY required. IDS=1,2,3 to pick records.
 */
import { GoogleGenAI } from "@google/genai";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_PATH = path.join(process.cwd(), "data", "records.json");
const OUT_DIR = path.join(process.cwd(), "data", "text-gemini");
const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const RENDER_DPI = parseInt(process.env.RENDER_DPI ?? "200", 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? "30", 10);
const PAGE_CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "4", 10);

if (!process.env.GOOGLE_API_KEY) {
  console.error("GOOGLE_API_KEY not set in .env");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

const PROMPT_PAGE =
  "Transcribe text from this scanned document page. Strict rules:\n" +
  "- Transcribe ONLY what you can clearly read. Never guess.\n" +
  "- For any word, phrase, or region you are not confident about, write [illegible] or [unclear: best guess?].\n" +
  "- Never repeat a word out of uncertainty. If you see what looks like a repeated word, transcribe it once, or use [illegible] if you can't tell.\n" +
  "- Preserve paragraph breaks and original line breaks where reasonable.\n" +
  "- Include headers, footers, page numbers, stamps (e.g. [stamp: ANSWERED]), signatures, marginalia, and crossed-out text (mark the latter with [strikethrough: ...]).\n" +
  "- For handwritten content, prefer [illegible] over a wrong reading.\n" +
  "- If the page is blank, output exactly: [blank page].\n" +
  "- Do not summarize, paraphrase, or add commentary. Output only the transcription.";

type StoredRecord = { id: number; title: string; fileUrl: string };

async function downloadPdf(url: string, dest: string) {
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

async function transcribePagePng(pngPath: string): Promise<string> {
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
        msg.includes("429") || msg.includes("resource_exhausted") || msg.includes("quota");
      if (!transient || attempt === max) throw err;
      // Pull retry hint from error if present, else exponential
      const m = msg.match(/retry in ([\d.]+)s/);
      const delayMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 1000 : 5000 * attempt;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("transcribePagePng: retries exhausted");
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ufo-gem-${r.id}-`));
  try {
    const pdfPath = path.join(tmpDir, "doc.pdf");
    const t0 = Date.now();
    console.log(`#${r.id} downloading…`);
    const sz = await downloadPdf(r.fileUrl, pdfPath);
    console.log(`#${r.id} ${(sz / 1024 / 1024).toFixed(1)} MB → rendering…`);
    execFileSync(
      "pdftoppm",
      ["-png", "-r", String(RENDER_DPI), "-l", String(MAX_PAGES), pdfPath, path.join(tmpDir, "page")],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const pages = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort();
    console.log(`#${r.id} ${pages.length} pages → transcribing with ${MODEL}…`);
    const transcripts = await pmap(pages, PAGE_CONCURRENCY, (p) =>
      transcribePagePng(path.join(tmpDir, p)),
    );
    const text = transcripts.map((t, i) => `--- PAGE ${i + 1} ---\n${t.trim()}`).join("\n\n");
    fs.writeFileSync(path.join(OUT_DIR, `${r.id}.txt`), text);
    console.log(
      `#${r.id} → ${pages.length}p, ${text.length}ch, ${Math.round((Date.now() - t0) / 1000)}s`,
    );
  } catch (err) {
    console.error(`#${r.id} FAIL: ${(err as Error).message}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const records: StoredRecord[] = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const ids = (process.env.IDS ?? "1").split(",").map((s) => parseInt(s, 10));
  const targets = records.filter((r) => ids.includes(r.id) && r.fileUrl?.endsWith(".pdf"));
  console.log(`Targets: ${targets.map((r) => r.id).join(",")} model=${MODEL} dpi=${RENDER_DPI}`);
  for (const r of targets) await processRecord(r);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
