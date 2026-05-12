/**
 * Validate data/records.json before it's committed.
 *
 * Run by CI on every push/PR (catches manual edits) and by the refresh
 * workflow after `pnpm fetch:csv` (catches a corrupt CSV pull).
 *
 * Exits non-zero on any error so the workflow refuses to commit.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DATA_PATH = path.join(process.cwd(), "data", "records.json");
const TEXT_DIR = path.join(process.cwd(), "data", "text");

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
  textChars?: number;
  extractionModel?: string;
  extractionPages?: number;
  firstSeenAt?: string;
  contentHash?: string;
};

function loadPrevious(): Map<number, StoredRecord> | null {
  // Compare against the version on prod (or origin/main if prod missing).
  // Returns null if we can't get a baseline (first run, no git, etc.).
  for (const ref of ["origin/prod", "origin/main", "HEAD~1"]) {
    try {
      const out = execFileSync("git", ["show", `${ref}:data/records.json`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const arr = JSON.parse(out) as StoredRecord[];
      if (Array.isArray(arr)) {
        return new Map(arr.map((r) => [r.id, r]));
      }
    } catch {
      // try next ref
    }
  }
  return null;
}

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
    if (r.contentHash && !/^[a-f0-9]{64}$/.test(r.contentHash)) {
      errors.push(`record ${r.id} has malformed contentHash: ${r.contentHash}`);
    }
  }

  // 3. Text-file presence: every record marked as extracted must have its file
  for (const r of records) {
    if (r.extractionModel) {
      const txtPath = path.join(TEXT_DIR, `${r.id}.txt`);
      if (!fs.existsSync(txtPath)) {
        errors.push(
          `record ${r.id} has extractionModel=${r.extractionModel} but no data/text/${r.id}.txt`,
        );
      } else if (typeof r.textChars === "number" && r.textChars > 0) {
        const actualSize = fs.statSync(txtPath).size;
        if (actualSize < 10) {
          errors.push(
            `record ${r.id} text file is suspiciously empty (${actualSize} bytes) but textChars=${r.textChars}`,
          );
        }
      }
    }
  }

  // 4. Reversion check vs the previous snapshot (origin/prod, then origin/main).
  const previous = loadPrevious();
  if (previous) {
    for (const r of records) {
      const prev = previous.get(r.id);
      if (!prev) continue;
      // Records that previously had text shouldn't suddenly have none.
      if (prev.extractionModel && !r.extractionModel) {
        errors.push(
          `record ${r.id} regression: had extractionModel=${prev.extractionModel}, now missing`,
        );
      }
      if (
        typeof prev.textChars === "number" &&
        prev.textChars > 200 &&
        typeof r.textChars === "number" &&
        r.textChars < prev.textChars / 2
      ) {
        warnings.push(
          `record ${r.id} text shrank ${prev.textChars}→${r.textChars} chars (>50% drop)`,
        );
      }
      // firstSeenAt is supposed to be immutable.
      if (prev.firstSeenAt && r.firstSeenAt && prev.firstSeenAt !== r.firstSeenAt) {
        errors.push(
          `record ${r.id} firstSeenAt changed: ${prev.firstSeenAt} → ${r.firstSeenAt}`,
        );
      }
    }
    // Total live record count shouldn't crater.
    const prevLive = Array.from(previous.values()).filter((r) => !r.removedFromSource).length;
    if (live.length < prevLive * 0.9) {
      errors.push(
        `live record count crashed: ${prevLive} → ${live.length} (>10% drop)`,
      );
    }
  } else {
    console.log("(no previous baseline available — skipping reversion checks)");
  }

  // 5. Report
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
