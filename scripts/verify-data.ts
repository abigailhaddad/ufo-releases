/**
 * Validate data/records.json before it's committed.
 *
 * Run by CI on every push/PR (catches manual edits) and by the refresh
 * workflow after `pnpm fetch:csv` (catches a corrupt CSV pull).
 *
 * Exits non-zero on any error so the workflow refuses to commit.
 */
import fs from "node:fs";
import path from "node:path";

const DATA_PATH = path.join(process.cwd(), "data", "records.json");

// Floors: tune as the dataset grows. Right now we have 161 records.
const MIN_TOTAL_RECORDS = 100;
const MIN_LIVE_RECORDS = 100;
const ALLOWED_TYPES = new Set(["PDF", "VID", "IMG", ""]);

type StoredRecord = {
  id: number;
  title: string;
  type: string;
  agency: string;
  fileUrl: string;
  thumbnailUrl: string;
  dvidsVideoId: string;
  removedFromSource?: boolean;
};

function isHttpUrl(s: string): boolean {
  if (!s) return true;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`MISSING: ${DATA_PATH}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch (err) {
    console.error(`UNPARSEABLE JSON: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    console.error("records.json is not an array");
    process.exit(1);
  }

  const records = parsed as StoredRecord[];
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Hard floors
  if (records.length < MIN_TOTAL_RECORDS) {
    errors.push(
      `only ${records.length} total records, expected at least ${MIN_TOTAL_RECORDS}`,
    );
  }
  const live = records.filter((r) => !r.removedFromSource);
  if (live.length < MIN_LIVE_RECORDS) {
    errors.push(
      `only ${live.length} live records, expected at least ${MIN_LIVE_RECORDS}`,
    );
  }

  // 2. Per-record checks
  const seenIds = new Set<number>();
  for (const r of records) {
    if (typeof r.id !== "number" || !Number.isInteger(r.id) || r.id <= 0) {
      errors.push(`record has bad id: ${JSON.stringify(r).slice(0, 100)}`);
      continue;
    }
    if (seenIds.has(r.id)) {
      errors.push(`duplicate id: ${r.id}`);
    }
    seenIds.add(r.id);

    const hasIdentifier = r.title || r.fileUrl || r.dvidsVideoId;
    if (!hasIdentifier) {
      errors.push(`record ${r.id} has no title, fileUrl, or dvidsVideoId`);
    }

    if (!ALLOWED_TYPES.has(r.type ?? "")) {
      warnings.push(`record ${r.id} has unexpected type ${JSON.stringify(r.type)}`);
    }

    if (r.fileUrl && !isHttpUrl(r.fileUrl)) {
      errors.push(`record ${r.id} has malformed fileUrl: ${r.fileUrl}`);
    }
    if (r.thumbnailUrl && !isHttpUrl(r.thumbnailUrl)) {
      errors.push(`record ${r.id} has malformed thumbnailUrl: ${r.thumbnailUrl}`);
    }
    if (
      r.dvidsVideoId &&
      !/^\d+$/.test(r.dvidsVideoId.trim())
    ) {
      warnings.push(`record ${r.id} has non-numeric DVIDS id: ${r.dvidsVideoId}`);
    }
  }

  // 3. Report
  for (const w of warnings) console.warn(`warn: ${w}`);

  if (errors.length) {
    console.error(`\nFAIL: ${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `OK: ${records.length} records (${live.length} live, ${records.length - live.length} archived), ${warnings.length} warning(s).`,
  );
}

main();
