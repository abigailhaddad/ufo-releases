/**
 * Regex-based keyword tagger. Scans each record's description + extracted
 * text against a curated rule list and writes a `tags: string[]` field on
 * the record so the UI can offer faceted filtering and surface the tags
 * inline.
 *
 * Tags are stable, lowercase, namespaced strings (e.g. "shape:saucer",
 * "sensor:flir"). Rules are intentionally narrow — false positives erode
 * trust faster than false negatives. A record with no matches gets `[]`.
 *
 * Re-run after extraction:
 *   pnpm tag:records
 */
import fs from "node:fs";
import path from "node:path";

const DATA_PATH = path.join(process.cwd(), "data", "records.json");
const TEXT_DIR = path.join(process.cwd(), "data", "text");

type Rule = { tag: string; pattern: RegExp };

// Order doesn't matter — every rule that matches contributes a tag.
const RULES: Rule[] = [
  // Shapes
  { tag: "shape:saucer", pattern: /\b(?:flying\s+)?(?:saucers?|discs?)\b/i },
  { tag: "shape:orb", pattern: /\b(?:orbs?|spheres?|spheroids?)\b/i },
  { tag: "shape:triangle", pattern: /\btriangular?\b|\btriangles\b/i },
  { tag: "shape:cigar", pattern: /\b(?:cigar(?:-shaped)?|cylindrical|cylinders?)\b/i },
  { tag: "shape:diamond", pattern: /\bdiamond(?:-shaped)?\b/i },
  { tag: "shape:oval", pattern: /\b(?:ovals?|elliptical|ellipses?)\b/i },
  { tag: "shape:cone", pattern: /\b(?:cones?|conical)\b/i },
  { tag: "shape:tic-tac", pattern: /\btic[-\s]?tacs?\b/i },

  // Color / luminosity
  { tag: "color:fireball", pattern: /\bfireballs?\b/i },
  { tag: "color:metallic", pattern: /\bmetallic\b/i },
  { tag: "color:glowing", pattern: /\bglowing|luminous\b/i },

  // Behavior
  { tag: "behavior:hovering", pattern: /\bhover(?:ed|ing)?\b/i },
  { tag: "behavior:formation", pattern: /\bformations?\b/i },
  { tag: "behavior:vanished", pattern: /\b(?:vanish(?:ed)?|disappeared?)\b/i },
  { tag: "behavior:accelerating", pattern: /\baccelerat(?:e|ed|es|ing|ion)\b/i },
  { tag: "behavior:stationary", pattern: /\bstationary\b/i },
  { tag: "behavior:maneuvering", pattern: /\bmaneuver(?:s|ed|ing|ability)?\b/i },

  // Sensors
  { tag: "sensor:flir", pattern: /\bflir\b/i },
  { tag: "sensor:swir", pattern: /\bswir\b/i },
  { tag: "sensor:radar", pattern: /\bradar\b/i },
  { tag: "sensor:infrared", pattern: /\binfra[-\s]?red\b/i },
  { tag: "sensor:telescope", pattern: /\btelescopes?\b/i },

  // Programs / agencies / projects
  { tag: "program:aaro", pattern: /\baaro\b/i },
  { tag: "program:nicap", pattern: /\bnicap\b/i },
  { tag: "program:project-blue-book", pattern: /\b(?:project\s+blue\s+book|bluebook)\b/i },
  { tag: "program:condon", pattern: /\bcondon(?:\s+report|\s+committee)?\b/i },
  { tag: "program:apollo", pattern: /\bapollo\s+\d+\b/i },
  { tag: "program:gemini", pattern: /\bgemini\s*\d+\b/i },
  { tag: "program:skylab", pattern: /\bskylab\b/i },

  // Witness type
  { tag: "witness:pilot", pattern: /\bpilots?\b/i },
  { tag: "witness:astronaut", pattern: /\bastronauts?\b/i },
  { tag: "witness:police", pattern: /\b(?:sheriffs?|police\s+officers?)\b/i },
  { tag: "witness:military", pattern: /\b(?:air\s+force|u\.?s\.?\s+navy|marines?)\b/i },
];

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
  for (const { tag, pattern } of RULES) {
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
