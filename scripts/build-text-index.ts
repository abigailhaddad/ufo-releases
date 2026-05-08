/**
 * Build artifacts the site needs from data/text/*.txt:
 *   - public/text/<id>.txt     (lazy-fetched per-record for the modal)
 *   - public/text-index.json   (id -> lowercased full text, for search)
 *
 * Runs at build time via package.json's prebuild hook.
 */
import fs from "node:fs";
import path from "node:path";

const TEXT_SRC = path.join(process.cwd(), "data", "text");
const PUBLIC_TEXT = path.join(process.cwd(), "public", "text");
const INDEX_PATH = path.join(process.cwd(), "public", "text-index.json");

function main() {
  if (!fs.existsSync(TEXT_SRC)) {
    fs.mkdirSync(TEXT_SRC, { recursive: true });
  }
  fs.rmSync(PUBLIC_TEXT, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC_TEXT, { recursive: true });

  const index: Record<string, string> = {};
  const files = fs.readdirSync(TEXT_SRC).filter((f) => f.endsWith(".txt"));
  for (const f of files) {
    const id = f.replace(/\.txt$/, "");
    const text = fs.readFileSync(path.join(TEXT_SRC, f), "utf8");
    fs.writeFileSync(path.join(PUBLIC_TEXT, f), text);
    index[id] = text.toLowerCase();
  }
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index));
  const totalChars = Object.values(index).reduce((s, v) => s + v.length, 0);
  console.log(
    `text-index: ${files.length} files, ${(totalChars / 1024 / 1024).toFixed(2)} MB total`,
  );
}

main();
