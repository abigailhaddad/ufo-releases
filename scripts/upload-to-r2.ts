/**
 * Mirror local files to the public R2 bucket so the site can fall back to R2
 * if war.gov / DVIDS go away.
 *
 * Layout in R2:
 *   pdfs/<id>.pdf       ← from data/_pdfs/
 *   media/<id>.<ext>    ← from data/_media/
 *   text/<id>.txt       ← from data/text/
 *
 * Idempotent: data/r2-manifest.json tracks every key we've successfully
 * uploaded (or confirmed already-exists). Subsequent runs skip those without
 * any remote call. If a key isn't in the manifest, we fall back to a remote
 * GET to verify before re-uploading.
 *
 * Env:
 *   BUCKET            R2 bucket name (default: ufo-releases)
 *   FORCE             1 to re-upload existing keys
 *   DRY_RUN           1 to list intended uploads without touching R2
 *   ONLY              "pdfs" | "media" | "text" | "all" (default: all)
 *   SKIP_REMOTE_CHECK 1 to skip the wrangler GET fallback for unknown keys
 *                       (i.e. trust the manifest as source of truth)
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BUCKET = process.env.BUCKET ?? "ufo-releases";
const FORCE = process.env.FORCE === "1";
const DRY_RUN = process.env.DRY_RUN === "1";
const SKIP_REMOTE_CHECK = process.env.SKIP_REMOTE_CHECK === "1";
const ONLY = (process.env.ONLY ?? "all").toLowerCase();

const ROOT = process.cwd();
const PDF_DIR = path.join(ROOT, "data", "_pdfs");
const MEDIA_DIR = path.join(ROOT, "data", "_media");
const TEXT_DIR = path.join(ROOT, "data", "text");
const MANIFEST_PATH = path.join(ROOT, "data", "r2-manifest.json");

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

type Manifest = {
  bucket: string;
  uploadedKeys: string[];
  lastUpdated: string;
};

function loadManifest(): { keys: Set<string>; data: Manifest } {
  const empty: Manifest = {
    bucket: BUCKET,
    uploadedKeys: [],
    lastUpdated: new Date().toISOString().slice(0, 10),
  };
  if (!fs.existsSync(MANIFEST_PATH)) return { keys: new Set(), data: empty };
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
    if (m.bucket !== BUCKET) {
      console.warn(
        `manifest is for bucket ${m.bucket}, this run is ${BUCKET} — starting fresh`,
      );
      return { keys: new Set(), data: empty };
    }
    return { keys: new Set(m.uploadedKeys), data: m };
  } catch (err) {
    console.warn(`couldn't read manifest: ${(err as Error).message}`);
    return { keys: new Set(), data: empty };
  }
}

function saveManifest(keys: Set<string>) {
  const data: Manifest = {
    bucket: BUCKET,
    uploadedKeys: Array.from(keys).sort(),
    lastUpdated: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(data, null, 2) + "\n");
}

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

function remoteObjectExists(bucket: string, key: string): boolean {
  // Slow fallback: streams the object body just to check existence. Used
  // only for keys not in the manifest.
  const res = spawnSync(
    "pnpm",
    ["exec", "wrangler", "r2", "object", "get", `${bucket}/${key}`, "--pipe", "--remote"],
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
      // Without --remote, wrangler writes to a local SQLite emulator, not R2.
      "--remote",
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

  const { keys: manifest } = loadManifest();
  console.log(`Manifest: ${manifest.size} keys already known uploaded.`);

  let uploaded = 0;
  let skippedManifest = 0;
  let skippedRemote = 0;
  let failed = 0;
  for (const g of groups) {
    console.log(`\n=== ${g.name} (${g.uploads.length}) ===`);
    for (const u of g.uploads) {
      const label = `${u.key.padEnd(36)} ${(u.sizeBytes / 1024 / 1024).toFixed(1).padStart(6)} MB`;
      if (!FORCE && manifest.has(u.key)) {
        skippedManifest += 1;
        continue;
      }
      if (!FORCE && !SKIP_REMOTE_CHECK && remoteObjectExists(BUCKET, u.key)) {
        // Already in R2 but not in manifest — backfill.
        manifest.add(u.key);
        skippedRemote += 1;
        continue;
      }
      const t0 = Date.now();
      process.stdout.write(`  ${label} … `);
      try {
        uploadOne(BUCKET, u);
        manifest.add(u.key);
        // Persist after every success so a crash doesn't lose progress.
        saveManifest(manifest);
        uploaded += 1;
        console.log(`${Math.round((Date.now() - t0) / 1000)}s`);
      } catch (err) {
        failed += 1;
        console.log(`FAIL ${(err as Error).message?.slice(0, 80)}`);
      }
    }
  }
  // Final write captures any remote-backfilled keys too.
  saveManifest(manifest);
  console.log(
    `\nDone. Uploaded ${uploaded}, skipped ${skippedManifest} (manifest), ${skippedRemote} (remote-backfilled), failed ${failed}.`,
  );
}

main();
