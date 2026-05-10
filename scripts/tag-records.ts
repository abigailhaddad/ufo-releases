/**
 * Regex-based keyword tagger. Scans each record's description + extracted
 * text against a curated rule list and writes a `tags: string[]` field on
 * the record so the UI can offer faceted filtering and surface the tags
 * inline.
 *
 * Tags are plain keywords (e.g. "saucer", "FLIR", "Apollo"). NOT an
 * authoritative classification — "pilot" tag means the word appeared
 * somewhere, not that the witness was a pilot. A record with no matches
 * gets `[]`.
 *
 * Edit src/lib/tag-rules.ts to add or change rules.
 *
 * Re-run after extraction:
 *   pnpm tag:records
 */
import fs from "node:fs";
import path from "node:path";
import { TAG_RULES } from "../src/lib/tag-rules";

const DATA_PATH = path.join(process.cwd(), "data", "records.json");
const TEXT_DIR = path.join(process.cwd(), "data", "text");

type StoredRecord = {
  id: number;
  description?: string;
  type?: string;
  removedFromSource?: boolean;
  tags?: string[];
};

function tagsForRecord(r: StoredRecord): string[] {
  const haystackParts: string[] = [];
  if (r.description) haystackParts.push(r.description);
  const txt = path.join(TEXT_DIR, `${r.id}.txt`);
  if (fs.existsSync(txt)) {
    haystackParts.push(fs.readFileSync(txt, "utf8"));
  }
  if (haystackParts.length === 0) return [];
  const haystack = haystackParts.join("\n");
  const found = new Set<string>();
  for (const { tag, pattern } of TAG_RULES) {
    if (pattern.test(haystack)) found.add(tag);
  }
  return Array.from(found).sort();
}

function main() {
  const records: StoredRecord[] = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  let touched = 0;
  let totalTags = 0;
  const tagCounts = new Map<string, number>();

  for (const r of records) {
    const next = tagsForRecord(r);
    const prev = r.tags ?? [];
    if (
      next.length !== prev.length ||
      next.some((t, i) => t !== prev[i])
    ) {
      r.tags = next;
      touched += 1;
    } else {
      r.tags = prev;
    }
    totalTags += next.length;
    for (const t of next) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(records, null, 2) + "\n");

  console.log(`Tagged ${records.length} records (${touched} updated). ${totalTags} tags total.`);
  console.log("Tag distribution:");
  const sorted = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [tag, count] of sorted) {
    console.log(`  ${count.toString().padStart(4)}  ${tag}`);
  }
}

main();
