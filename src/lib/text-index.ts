/**
 * Shared contract for the client-side full-text search index.
 *
 * One module so the writer (scripts/build-text-index.ts) and the reader
 * (components/records-table.tsx) can't drift: same directory name, same
 * manifest shape, same normalisation, same shard budget.
 *
 * Why this exists at all: the search index used to be a single
 * public/text-index.json of 28,171,729 bytes, which is over Cloudflare Pages'
 * hard 25 MiB per-file limit. Two changes fix that:
 *
 *  1. Normalise. The index only ever gets substring-searched and sliced for
 *     snippets, so the OCR layout whitespace in it is dead weight -- runs of
 *     spaces used to pad columns on the scanned page. Collapsing them is 2.7x
 *     smaller and makes search *better*, not worse (see normalizeForSearch).
 *  2. Shard to a byte budget, not a fixed count. File count then grows with
 *     the corpus and no single file drifts back toward the host's limit as
 *     more records get transcribed.
 */

/** Directory under public/ (and therefore under the site root) holding the index. */
export const TEXT_INDEX_DIR = "text-index";

/** Manifest filename inside TEXT_INDEX_DIR. */
export const TEXT_INDEX_MANIFEST = "manifest.json";

/**
 * Target bytes per shard. Well under the 25 MiB host limit so that a single
 * unusually large record can't push a shard over, and small enough that shards
 * download in parallel.
 */
export const SHARD_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * Cloudflare Pages' hard per-file limit: 25 MiB. Anything at or above this is
 * rejected at deploy time, so the build fails on it instead (see
 * scripts/check-output-size.ts).
 */
export const MAX_PUBLISHED_FILE_BYTES = 25 * 1024 * 1024; // 26,214,400

/** id (as string) -> normalised searchable text. */
export type TextIndex = Record<string, string>;

export type TextIndexShardInfo = {
  /** Filename, relative to TEXT_INDEX_DIR. */
  file: string;
  /** Number of records packed into this shard. */
  records: number;
  /** Serialised size of the shard file in bytes. */
  bytes: number;
};

export type TextIndexManifest = {
  version: 1;
  generatedAt: string;
  recordCount: number;
  totalBytes: number;
  shards: TextIndexShardInfo[];
};

/**
 * Lowercase + collapse every whitespace run to a single space.
 *
 * Search is a case-insensitive substring test and snippets are a raw slice
 * around the hit, so neither cares about the original line breaks or the
 * column padding OCR leaves behind. Collapsing is a strict improvement:
 *
 *   - a phrase broken across a line break ("...records\n  center...") now
 *     matches the query "records center", which it did not before;
 *   - snippets stop being 280 characters of mostly spaces.
 *
 * The reading view is unaffected -- it renders public/text/<id>.txt, which
 * keeps its original casing and layout.
 */
export function normalizeForSearch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Zero-padded shard filename, e.g. shard-000.json. */
export function shardFileName(i: number): string {
  return `shard-${String(i).padStart(3, "0")}.json`;
}

/** UTF-8 byte length. TextEncoder exists in both Node and the browser. */
const byteLen = (s: string) => new TextEncoder().encode(s).length;

/**
 * Greedily pack [id, text] entries into groups whose serialised size stays
 * under `budget`. A single record larger than the budget gets a shard to
 * itself rather than being split, so ids stay whole and the reader stays a
 * plain Object.assign.
 */
export function packShards(
  entries: [string, string][],
  budget: number = SHARD_BUDGET_BYTES,
): [string, string][][] {
  const shards: [string, string][][] = [];
  let current: [string, string][] = [];
  let currentBytes = 2; // "{}"
  for (const entry of entries) {
    // key + value + quotes + separators; a safe over-estimate of the JSON cost.
    const cost = byteLen(entry[0]) + byteLen(entry[1]) + 8;
    if (current.length > 0 && currentBytes + cost > budget) {
      shards.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(entry);
    currentBytes += cost;
  }
  if (current.length > 0) shards.push(current);
  return shards;
}

/**
 * Fetch the manifest, then every shard in parallel, and merge them into one
 * index object. Resolves to {} if the index is missing or unreadable -- the
 * table still renders and searches metadata, it just can't search body text.
 */
export async function loadTextIndex(
  basePath = `/${TEXT_INDEX_DIR}`,
  fetchImpl: typeof fetch = fetch,
): Promise<TextIndex> {
  const manifestRes = await fetchImpl(`${basePath}/${TEXT_INDEX_MANIFEST}`);
  if (!manifestRes.ok) throw new Error(`manifest HTTP ${manifestRes.status}`);
  const manifest = (await manifestRes.json()) as TextIndexManifest;
  const parts = await Promise.all(
    manifest.shards.map(async (s) => {
      const res = await fetchImpl(`${basePath}/${s.file}`);
      if (!res.ok) throw new Error(`${s.file} HTTP ${res.status}`);
      return (await res.json()) as TextIndex;
    }),
  );
  const index: TextIndex = {};
  for (const part of parts) Object.assign(index, part);
  return index;
}
