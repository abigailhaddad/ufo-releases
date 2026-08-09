/**
 * Fail the build if anything in the published set is too big for the host.
 *
 * Cloudflare Pages rejects any single file of 25 MiB (26,214,400 bytes) or
 * more at upload time -- the whole deploy fails, not just that file. This ran
 * into that: public/text-index.json was 28,171,729 bytes. Catching it here
 * means the next time a record's transcription balloons, CI says so instead of
 * a deploy dying.
 *
 * Usage:
 *   tsx scripts/check-output-size.ts [dir]     # default: out
 *
 * Env:
 *   MAX_FILE_BYTES  override the limit (used by the negative test)
 *   TOP             how many largest files to print (default 5)
 */
import fs from "node:fs";
import path from "node:path";
import { MAX_PUBLISHED_FILE_BYTES } from "../src/lib/text-index";

const DIR = path.resolve(process.cwd(), process.argv[2] ?? "out");
const LIMIT = Number(process.env.MAX_FILE_BYTES ?? MAX_PUBLISHED_FILE_BYTES);
const TOP = Number(process.env.TOP ?? 5);
/** Below this fraction of the limit we say nothing; above it, we warn. */
const WARN_AT = 0.8;

function walk(dir: string, out: { file: string; bytes: number }[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push({ file: p, bytes: fs.statSync(p).size });
  }
  return out;
}

function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`check-output-size: ${DIR} does not exist -- run the build first.`);
    process.exit(1);
  }
  const files = walk(DIR).sort((a, b) => b.bytes - a.bytes);
  if (files.length === 0) {
    console.error(`check-output-size: ${DIR} is empty.`);
    process.exit(1);
  }

  const rel = (f: string) => path.relative(process.cwd(), f);
  console.log(`check-output-size: ${files.length} files in ${rel(DIR)}, limit ${LIMIT} bytes`);
  for (const f of files.slice(0, TOP)) {
    console.log(`  ${String(f.bytes).padStart(10)}  ${rel(f.file)}`);
  }

  const over = files.filter((f) => f.bytes >= LIMIT);
  if (over.length > 0) {
    console.error(
      `\ncheck-output-size: FAIL -- ${over.length} file(s) at or over the ${LIMIT}-byte limit:`,
    );
    for (const f of over) {
      console.error(`  ${f.bytes} bytes (${(f.bytes - LIMIT).toLocaleString()} over)  ${rel(f.file)}`);
    }
    console.error(
      "\nCloudflare Pages rejects the entire deploy when any single file hits this limit.",
    );
    process.exit(1);
  }

  const near = files.filter((f) => f.bytes >= LIMIT * WARN_AT);
  for (const f of near) {
    console.warn(
      `check-output-size: WARN -- ${rel(f.file)} is ${f.bytes} bytes, ` +
        `${((100 * f.bytes) / LIMIT).toFixed(1)}% of the limit`,
    );
  }

  console.log(
    `check-output-size: OK -- largest is ${files[0].bytes} bytes (${rel(files[0].file)}), ` +
      `${((100 * files[0].bytes) / LIMIT).toFixed(1)}% of the limit`,
  );
}

main();
