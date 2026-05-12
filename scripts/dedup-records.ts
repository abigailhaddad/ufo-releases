/**
 * Collapse duplicate records in data/records.json.
 *
 * Two records are considered duplicates when:
 *   1. They share a normalized filename basename + agency + type (the
 *      "filename bucket"), AND
 *   2. They are *field-identical* on the source-derived columns
 *      (title, fileUrl, dvidsVideoId, videoTitle, description).
 *
 * Only field-identical pairs are auto-merged. Two records can share a
 * filename bucket without being the same logical document — for example,
 * id 29 and id 30 in the historical data both normalize to the same
 * basename (`59_214434_sp_16_7.18.1963.pdf` and the bracketed variant),
 * but their titles point to two different State Dept file numbers. Those
 * stay separate; we log them so a human can decide.
 *
 * When merging:
 *   - Survivor id = oldest archived id in the field-identical group, or
 *     the lowest live id if there is no archived match. This preserves
 *     firstSeenAt across rename pairs and avoids creating new ids when
 *     two live rows are the same.
 *   - Survivor record = live row's content + archived row's bookkeeping
 *     fields (firstSeenAt, textChars, extractionModel, extractionPages).
 *   - All other rows in the group are dropped.
 *
 * Runs after `pnpm fetch:csv` and before `pnpm verify:data` in CI.
 */
import fs from "node:fs";
import path from "node:path";

const DATA_PATH = path.join(process.cwd(), "data", "records.json");

type Rec = {
  id: number;
  title: string;
  type: string;
  agency: string;
  fileUrl: string;
  thumbnailUrl?: string;
  dvidsVideoId?: string;
  videoTitle?: string;
  description?: string;
  removedFromSource?: boolean;
  firstSeenAt?: string;
  lastSeenAt?: string;
  textChars?: number;
  extractionModel?: string;
  extractionPages?: number;
  [k: string]: unknown;
};

function normalizeBasename(url: string): string {
  if (!url) return "";
  const last = (url.split("/").pop() ?? "").split("?")[0];
  const stem = last.replace(/\.[a-z0-9]+$/i, "");
  return stem
    .toLowerCase()
    .replace(/\d+/g, (n) => String(parseInt(n, 10)))
    .replace(/[^a-z0-9]/g, "");
}

function bucketKey(r: Rec): string | null {
  const norm = normalizeBasename(r.fileUrl);
  if (!norm) return null;
  return `${r.agency}::${r.type}::${norm}`;
}

function fingerprint(r: Rec): string {
  // Source-derived fields only. If two records agree on all of these, they
  // came from identical CSV rows (or near-identical rename pairs) and are
  // safe to collapse. Excludes bookkeeping (id, firstSeenAt, removedFromSource).
  return JSON.stringify({
    title: r.title ?? "",
    fileUrl: r.fileUrl ?? "",
    dvidsVideoId: r.dvidsVideoId ?? "",
    videoTitle: r.videoTitle ?? "",
    description: r.description ?? "",
  });
}

export function dedup(records: Rec[]): { records: Rec[]; merged: number } {
  const buckets = new Map<string, Rec[]>();
  for (const r of records) {
    const k = bucketKey(r);
    if (!k) continue;
    let arr = buckets.get(k);
    if (!arr) {
      arr = [];
      buckets.set(k, arr);
    }
    arr.push(r);
  }

  const dropped = new Set<number>();
  const replacements = new Map<number, Rec>();
  let mergeGroups = 0;

  for (const [bucketKeyStr, rs] of buckets) {
    if (rs.length < 2) continue;

    const fpGroups = new Map<string, Rec[]>();
    for (const r of rs) {
      const fp = fingerprint(r);
      let g = fpGroups.get(fp);
      if (!g) {
        g = [];
        fpGroups.set(fp, g);
      }
      g.push(r);
    }

    let bucketMergeCount = 0;
    for (const group of fpGroups.values()) {
      if (group.length < 2) continue;

      const archived = group
        .filter((r) => r.removedFromSource)
        .sort((a, b) => a.id - b.id);
      const live = group
        .filter((r) => !r.removedFromSource)
        .sort((a, b) => a.id - b.id);

      // All archived: leave alone (already retired).
      if (live.length === 0) continue;

      const base = archived[0] ?? live[0];
      const source = live[0];
      const survivorId = base.id;

      const merged: Rec = {
        ...base,
        ...source,
        id: survivorId,
        firstSeenAt: base.firstSeenAt ?? source.firstSeenAt,
        removedFromSource: false,
      };
      // Carry forward extraction metadata from whichever record has it.
      // (Field-identical content → identical extraction, so we only need
      // to make sure we don't lose it.)
      const m = merged as Record<string, unknown>;
      for (const f of ["textChars", "extractionModel", "extractionPages"]) {
        if (m[f] === undefined) {
          if ((base as Record<string, unknown>)[f] !== undefined) {
            m[f] = (base as Record<string, unknown>)[f];
          } else if ((source as Record<string, unknown>)[f] !== undefined) {
            m[f] = (source as Record<string, unknown>)[f];
          }
        }
      }
      replacements.set(survivorId, merged);

      const droppedIds: number[] = [];
      for (const r of group) {
        if (r.id !== survivorId) {
          dropped.add(r.id);
          droppedIds.push(r.id);
        }
      }
      console.log(
        `dedup: ${group.length} identical → keep id ${survivorId}, drop ${droppedIds.join(",")}`,
      );
      bucketMergeCount += 1;
      mergeGroups += 1;
    }

    // Anything in this bucket that wasn't part of an identical group is an
    // ambiguous collision — log so a human can review.
    const unresolved = rs.filter(
      (r) => !dropped.has(r.id) && !replacements.has(r.id),
    );
    if (bucketMergeCount === 0 && unresolved.length >= 2) {
      const names = unresolved
        .map((r) => `${r.id}${r.removedFromSource ? "A" : "L"}`)
        .join(",");
      console.warn(
        `warn: filename collision in bucket "${bucketKeyStr.split("::")[2]}" with non-identical content (ids ${names}); leaving as-is`,
      );
    }
  }

  const out = records
    .map((r) => replacements.get(r.id) ?? r)
    .filter((r) => !dropped.has(r.id));
  out.sort((a, b) => a.id - b.id);

  return { records: out, merged: dropped.size };
}

function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`MISSING: ${DATA_PATH}`);
    process.exit(1);
  }
  const records = JSON.parse(fs.readFileSync(DATA_PATH, "utf8")) as Rec[];
  const before = records.length;
  const { records: out, merged } = dedup(records);
  if (merged === 0) {
    console.log("dedup: no duplicate groups found");
    return;
  }
  fs.writeFileSync(DATA_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`dedup: dropped ${merged} record(s). ${before} → ${out.length} records.`);
}

main();
