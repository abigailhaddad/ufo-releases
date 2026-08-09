/**
 * Build artifacts the site needs from data/text/*.txt:
 *   - public/text/<id>.txt              (lazy-fetched per-record, reading view:
 *                                        original casing + original layout)
 *   - public/text-index/manifest.json   (list of shards)
 *   - public/text-index/shard-NNN.json  (id -> normalised text, for search)
 *
 * The search index used to be one public/text-index.json of ~28 MB, which is
 * over Cloudflare Pages' hard 25 MiB per-file limit. It is now normalised
 * (2.7x smaller -- see normalizeForSearch) and split across shards packed to a
 * byte budget, so the file count grows with the corpus instead of one file
 * growing back toward the limit.
 *
 * Runs at build time via package.json's prebuild hook.
 */
import fs from "node:fs";
import path from "node:path";
import {
  MAX_PUBLISHED_FILE_BYTES,
  SHARD_BUDGET_BYTES,
  TEXT_INDEX_DIR,
  TEXT_INDEX_MANIFEST,
  normalizeForSearch,
  packShards,
  shardFileName,
  type TextIndexManifest,
  type TextIndexShardInfo,
} from "../src/lib/text-index";

const TEXT_SRC = path.join(process.cwd(), "data", "text");
const PUBLIC_TEXT = path.join(process.cwd(), "public", "text");
const INDEX_DIR = path.join(process.cwd(), "public", TEXT_INDEX_DIR);
/** Pre-shard artifact. Removed so a stale 28 MB copy can't get published. */
const LEGACY_INDEX_PATH = path.join(process.cwd(), "public", "text-index.json");

function main() {
  if (!fs.existsSync(TEXT_SRC)) {
    fs.mkdirSync(TEXT_SRC, { recursive: true });
  }
  fs.rmSync(PUBLIC_TEXT, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC_TEXT, { recursive: true });
  fs.rmSync(INDEX_DIR, { recursive: true, force: true });
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  fs.rmSync(LEGACY_INDEX_PATH, { force: true });

  const entries: [string, string][] = [];
  let rawChars = 0;
  const files = fs.readdirSync(TEXT_SRC).filter((f) => f.endsWith(".txt"));
  for (const f of files) {
    const id = f.replace(/\.txt$/, "");
    const text = fs.readFileSync(path.join(TEXT_SRC, f), "utf8");
    // The reading view gets the text verbatim -- casing and page layout intact.
    fs.writeFileSync(path.join(PUBLIC_TEXT, f), text);
    rawChars += text.length;
    const normalized = normalizeForSearch(text);
    if (normalized) entries.push([id, normalized]);
  }

  const shards = packShards(entries, SHARD_BUDGET_BYTES);
  const shardInfo: TextIndexShardInfo[] = [];
  shards.forEach((shard, i) => {
    const file = shardFileName(i);
    const body = JSON.stringify(Object.fromEntries(shard));
    fs.writeFileSync(path.join(INDEX_DIR, file), body);
    shardInfo.push({
      file,
      records: shard.length,
      bytes: Buffer.byteLength(body),
    });
  });

  const manifest: TextIndexManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    recordCount: entries.length,
    totalBytes: shardInfo.reduce((s, x) => s + x.bytes, 0),
    shards: shardInfo,
  };
  fs.writeFileSync(
    path.join(INDEX_DIR, TEXT_INDEX_MANIFEST),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  // Fail the build here rather than at deploy time. A single record bigger
  // than the budget gets its own shard, so this can only trip if one record's
  // normalised text is itself over the host limit.
  const oversized = shardInfo.filter((s) => s.bytes >= MAX_PUBLISHED_FILE_BYTES);
  if (oversized.length > 0) {
    console.error(
      `text-index: ${oversized.length} shard(s) at/over the ${MAX_PUBLISHED_FILE_BYTES}-byte host limit:`,
    );
    for (const s of oversized) console.error(`  ${s.file}  ${s.bytes} bytes`);
    process.exit(1);
  }

  const largest = shardInfo.reduce((a, b) => (b.bytes > a.bytes ? b : a), shardInfo[0]);
  console.log(
    `text-index: ${files.length} files, ${(rawChars / 1024 / 1024).toFixed(2)} MB raw ` +
      `-> ${shardInfo.length} shard(s), ${manifest.totalBytes} bytes total, ` +
      `largest ${largest ? `${largest.file} ${largest.bytes}` : "0"} bytes`,
  );
}

main();
