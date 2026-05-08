/**
 * Mirror local files to the public R2 bucket so the site can fall back to R2
 * if war.gov / DVIDS go away.
 *
 * Layout in R2:
 *   pdfs/<id>.pdf       ← from data/_pdfs/
 *   media/<id>.<ext>    ← from data/_media/
 *   text/<id>.txt       ← from data/text/
 *
 * Uses `wrangler r2 object put` so we don't need separate API token setup —
 * the user is already logged in via `wrangler login`. Sequential per file
 * (R2 latency dominates anyway), idempotent — call with FORCE=1 to re-upload.
 *
 * Env:
 *   BUCKET            R2 bucket name (default: ufo-releases)
 *   FORCE             1 to re-upload existing keys
 *   DRY_RUN           1 to list intended uploads without touching R2
 *   ONLY              "pdfs" | "media" | "text" | "all" (default: all)
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BUCKET = process.env.BUCKET ?? "ufo-releases";
const FORCE = process.env.FORCE === "1";
const DRY_RUN = process.env.DRY_RUN === "1";
const ONLY = (process.env.ONLY ?? "all").toLowerCase();

const ROOT = process.cwd();
const PDF_DIR = path.join(ROOT, "data", "_pdfs");
const MEDIA_DIR = path.join(ROOT, "data", "_media");
const TEXT_DIR = path.join(ROOT, "data", "text");

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
};

type Upload = { key: string; localPath: string; sizeBytes: number };

function listDir(dir: string, keyPrefix: string): Upload[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (!st.isFile()) return null;
      return {
        key: `${keyPrefix}/${f}`,
        localPath: p,
        sizeBytes: st.size,
      } as Upload;
    })
    .filter((u): u is Upload => u !== null);
}

function objectExists(bucket: string, key: string): boolean {
  // Returns 0 if exists, non-zero otherwise. Quietly suppress all output —
  // wrangler logs to stderr on errors.
  const res = spawnSync(
    "pnpm",
    ["exec", "wrangler", "r2", "object", "get", `${bucket}/${key}`, "--pipe"],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  return res.status === 0;
}

function uploadOne(bucket: string, u: Upload) {
  const ext = path.extname(u.key).toLowerCase();
  const ctype = CONTENT_TYPES[ext] ?? "application/octet-stream";
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucket}/${u.key}`,
      "--file",
      u.localPath,
      "--content-type",
      ctype,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

function main() {
  const groups: { name: string; uploads: Upload[] }[] = [];
  if (ONLY === "all" || ONLY === "pdfs") {
    groups.push({ name: "pdfs", uploads: listDir(PDF_DIR, "pdfs") });
  }
  if (ONLY === "all" || ONLY === "media") {
    groups.push({ name: "media", uploads: listDir(MEDIA_DIR, "media") });
  }
  if (ONLY === "all" || ONLY === "text") {
    groups.push({ name: "text", uploads: listDir(TEXT_DIR, "text") });
  }

  const totalFiles = groups.reduce((s, g) => s + g.uploads.length, 0);
  const totalBytes = groups.reduce(
    (s, g) => s + g.uploads.reduce((b, u) => b + u.sizeBytes, 0),
    0,
  );
  console.log(
    `Bucket: ${BUCKET} · ${totalFiles} files · ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`,
  );
  if (DRY_RUN) {
    for (const g of groups) {
      console.log(`\n${g.name}: ${g.uploads.length} files`);
      for (const u of g.uploads.slice(0, 5)) {
        console.log(`  ${u.key}  (${(u.sizeBytes / 1024 / 1024).toFixed(1)} MB)`);
      }
      if (g.uploads.length > 5) console.log(`  …+${g.uploads.length - 5} more`);
    }
    return;
  }

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  for (const g of groups) {
    console.log(`\n=== ${g.name} (${g.uploads.length}) ===`);
    for (const u of g.uploads) {
      const label = `${u.key.padEnd(36)} ${(u.sizeBytes / 1024 / 1024).toFixed(1).padStart(6)} MB`;
      if (!FORCE && objectExists(BUCKET, u.key)) {
        skipped += 1;
        continue;
      }
      const t0 = Date.now();
      process.stdout.write(`  ${label} … `);
      try {
        uploadOne(BUCKET, u);
        uploaded += 1;
        console.log(`${Math.round((Date.now() - t0) / 1000)}s`);
      } catch (err) {
        failed += 1;
        console.log(`FAIL ${(err as Error).message?.slice(0, 80)}`);
      }
    }
  }
  console.log(`\nDone. Uploaded ${uploaded}, skipped ${skipped} (existed), failed ${failed}.`);
}

main();
