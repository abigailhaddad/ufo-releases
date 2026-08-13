/**
 * Collapse duplicate records in data/records.json.
 *
 * Two records are merged when EITHER of these holds:
 *
 *   1. Hash match — both records have a `contentHash` and share it, AND
 *      agree on agency and type. SHA-256 collisions are cryptographically
 *      negligible, so a hash match means the underlying PDF bytes are
 *      identical. This is the rename-pair detector that survives URL or
 *      title rewrites (the case that originally produced id 30/162 and
 *      41/163 splits). Hashes are populated by download-pdfs.ts.
 *
 *   2. Field-identical match — same normalized filename basename + agency
 *      + type (the "filename bucket"), AND same source-derived fields
 *      (title, fileUrl, dvidsVideoId, videoTitle, description). Catches
 *      literal CSV row duplicates that fetch-csv can't collapse because
 *      its merge key allows multiple existing records to share the same
 *      fileUrl. Runs even when hashes are absent.
 *
 * Records that share a filename bucket but disagree on fields (and have
 * no hash signal either way) are NOT merged — they get a warning so a
 * human can review. Example: id 29 (title `59_214434_SP 16 [7.18.1963]`)
 * and archived id 30 (title `59_64634_711.5612[7-2852`) normalize to the
 * same basename but reference different State Dept file numbers.
 *
 * Merge groups are computed via union-find so transitively-linked records
 * (e.g., A=B by hash, B=C by fields) stay in one group.
 *
 * Survivor id: oldest archived id if any in the group; else lowest live
 * id. Survivor record: live row's source-derived fields overlaid on the
 * archived row's bookkeeping (firstSeenAt, textChars, extractionModel,
 * extractionPages, contentHash).
 *
 * Runs after `pnpm fetch:csv` in refresh-csv.yml (catches field-identical
 * dupes) and again after `pnpm download:pdfs` in extract-text.yml (catches
 * hash-match rename pairs once the new PDFs have been hashed).
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
  contentHash?: string;
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

function fileBucketKey(r: Rec): string | null {
  const norm = normalizeBasename(r.fileUrl);
  if (!norm) return null;
  return `${r.agency}::${r.type}::${norm}`;
}

function fingerprint(r: Rec): string {
  return JSON.stringify({
    title: r.title ?? "",
    fileUrl: r.fileUrl ?? "",
    dvidsVideoId: r.dvidsVideoId ?? "",
    videoTitle: r.videoTitle ?? "",
    description: r.description ?? "",
  });
}

class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function dedup(records: Rec[]): { records: Rec[]; merged: number } {
  const uf = new UnionFind();
  for (const r of records) uf.find(r.id);

  // Pass 1 — hash match. Strongest signal.
  const byHash = new Map<string, number[]>();
  for (const r of records) {
    if (!r.contentHash) continue;
    const k = `${r.contentHash}::${r.agency}::${r.type}`;
    let arr = byHash.get(k);
    if (!arr) {
      arr = [];
      byHash.set(k, arr);
    }
    arr.push(r.id);
  }
  for (const ids of byHash.values()) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i]);
  }

  // Pass 2 — same filename bucket AND identical source fields.
  const byFileAndFp = new Map<string, number[]>();
  for (const r of records) {
    const fk = fileBucketKey(r);
    if (!fk) continue;
    const key = `${fk}::${fingerprint(r)}`;
    let arr = byFileAndFp.get(key);
    if (!arr) {
      arr = [];
      byFileAndFp.set(key, arr);
    }
    arr.push(r.id);
  }
  for (const ids of byFileAndFp.values()) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i]);
  }

  // Surface filename-bucket collisions that did NOT match by either rule
  // — they're the ambiguous cases a human should review.
  const byFileBucket = new Map<string, Rec[]>();
  for (const r of records) {
    const k = fileBucketKey(r);
    if (!k) continue;
    let arr = byFileBucket.get(k);
    if (!arr) {
      arr = [];
      byFileBucket.set(k, arr);
    }
    arr.push(r);
  }

  // Build groups from union-find.
  const groups = new Map<number, Rec[]>();
  for (const r of records) {
    const root = uf.find(r.id);
    let arr = groups.get(root);
    if (!arr) {
      arr = [];
      groups.set(root, arr);
    }
    arr.push(r);
  }

  const dropped = new Set<number>();
  const replacements = new Map<number, Rec>();

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const archived = group.filter((r) => r.removedFromSource).sort((a, b) => a.id - b.id);
    const live = group.filter((r) => !r.removedFromSource).sort((a, b) => a.id - b.id);

    if (live.length === 0) continue; // all archived — leave alone

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
    // The survivor is live, so it must not inherit the archived row's
    // lastSeenAt — that field only exists on records gone from the source.
    delete merged.lastSeenAt;
    const m = merged as Record<string, unknown>;
    for (const f of ["textChars", "extractionModel", "extractionPages", "contentHash"]) {
      if (m[f] === undefined) {
        const bv = (base as Record<string, unknown>)[f];
        const sv = (source as Record<string, unknown>)[f];
        if (bv !== undefined) m[f] = bv;
        else if (sv !== undefined) m[f] = sv;
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
    const reason =
      archived.length > 0 && live.length > 0
        ? group.every((r) => r.contentHash === group[0].contentHash && r.contentHash)
          ? "hash"
          : "rename-pair"
        : "duplicate-rows";
    console.log(
      `dedup: ${group.length} → keep id ${survivorId}, drop ${droppedIds.join(",")} (${reason})`,
    );
  }

  // Warnings: filename-bucket collisions that didn't get merged.
  for (const [bk, bucket] of byFileBucket) {
    if (bucket.length < 2) continue;
    const remaining = bucket.filter((r) => !dropped.has(r.id));
    if (remaining.length < 2) continue;
    // Different union-find roots → not merged.
    const roots = new Set(remaining.map((r) => uf.find(r.id)));
    if (roots.size > 1) {
      const names = remaining
        .map((r) => `${r.id}${r.removedFromSource ? "A" : "L"}`)
        .join(",");
      console.warn(
        `warn: filename collision in bucket "${bk.split("::")[2]}" with non-identical content (ids ${names}); leaving as-is`,
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
