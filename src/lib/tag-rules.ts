/**
 * Plain-keyword tag rules. Each rule is just a regex pattern and the tag
 * label that appears when it matches in a record's description or
 * extracted text.
 *
 * NOT an authoritative classification — "pilot" tag means the word
 * appeared somewhere, not that the witness was a pilot.
 *
 * Imported by both scripts/tag-records.ts (writes records.json) and the
 * UI (highlights matched fragments in the table).
 */
export type TagRule = { tag: string; pattern: RegExp };

export const TAG_RULES: TagRule[] = [
  { tag: "saucer", pattern: /\b(?:flying\s+)?(?:saucers?|discs?)\b/i },
  { tag: "orb", pattern: /\b(?:orbs?|spheres?|spheroids?)\b/i },
  { tag: "triangle", pattern: /\btriangular?\b|\btriangles\b/i },
  { tag: "cigar", pattern: /\b(?:cigar(?:-shaped)?|cylindrical|cylinders?)\b/i },
  { tag: "diamond", pattern: /\bdiamond(?:-shaped)?\b/i },
  { tag: "oval", pattern: /\b(?:ovals?|elliptical|ellipses?)\b/i },
  { tag: "cone", pattern: /\b(?:cones?|conical)\b/i },
  { tag: "tic-tac", pattern: /\btic[-\s]?tacs?\b/i },
  { tag: "fireball", pattern: /\bfireballs?\b/i },
  { tag: "metallic", pattern: /\bmetallic\b/i },
  { tag: "glowing", pattern: /\b(?:glowing|luminous)\b/i },
  { tag: "hovering", pattern: /\bhover(?:ed|ing)?\b/i },
  { tag: "formation", pattern: /\bformations?\b/i },
  { tag: "vanished", pattern: /\b(?:vanish(?:ed)?|disappeared?)\b/i },
  { tag: "accelerating", pattern: /\baccelerat(?:e|ed|es|ing|ion)\b/i },
  { tag: "stationary", pattern: /\bstationary\b/i },
  { tag: "maneuvering", pattern: /\bmaneuver(?:s|ed|ing|ability)?\b/i },
  { tag: "FLIR", pattern: /\bflir\b/i },
  { tag: "SWIR", pattern: /\bswir\b/i },
  { tag: "radar", pattern: /\bradar\b/i },
  { tag: "infrared", pattern: /\binfra[-\s]?red\b/i },
  { tag: "telescope", pattern: /\btelescopes?\b/i },
  { tag: "AARO", pattern: /\baaro\b/i },
  { tag: "NICAP", pattern: /\bnicap\b/i },
  { tag: "Project Blue Book", pattern: /\b(?:project\s+blue\s+book|bluebook)\b/i },
  { tag: "Condon", pattern: /\bcondon(?:\s+report|\s+committee)?\b/i },
  { tag: "Apollo", pattern: /\bapollo\s+\d+\b/i },
  { tag: "Gemini", pattern: /\bgemini\s*\d+\b/i },
  { tag: "Skylab", pattern: /\bskylab\b/i },
  { tag: "pilot", pattern: /\bpilots?\b/i },
  { tag: "astronaut", pattern: /\bastronauts?\b/i },
  { tag: "police", pattern: /\b(?:sheriffs?|police\s+officers?)\b/i },
  { tag: "military", pattern: /\b(?:air\s+force|u\.?s\.?\s+navy|marines?)\b/i },
];

const RULE_BY_TAG: Map<string, RegExp> = new Map(TAG_RULES.map((r) => [r.tag, r.pattern]));

/**
 * Build a single combined regex (with /gi flags) that matches any of the
 * given tags' source patterns. Returns null if no rules match.
 */
export function combinedRegex(tags: Iterable<string>): RegExp | null {
  const sources: string[] = [];
  for (const t of tags) {
    const p = RULE_BY_TAG.get(t);
    if (p) sources.push(p.source);
  }
  if (sources.length === 0) return null;
  return new RegExp(sources.join("|"), "gi");
}
