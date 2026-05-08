# UAP / UFO Release Index

Searchable, sortable mirror of the declassified UAP records the U.S. Department of War publishes at [war.gov/UFO](https://www.war.gov/UFO/).

The official site is JS-heavy and inconvenient to browse, so this site reads the same source CSV they ship and renders it as a normal table.

> **Heads up: this site is not mirroring or scraping any of the actual files.** Every "Open" / "Watch" link points directly at the original government-hosted PDF, image, or DVIDS video on `war.gov` / `dvidshub.net`. We only mirror the metadata (titles, descriptions, agencies, dates, file URLs) from the CSV they publish at `war.gov/Portals/1/Interactive/2026/UFO/uap-csv.csv`. If `war.gov` takes a file down, that link will break here too — preserving the files themselves to Cloudflare R2 is a planned follow-up, not yet built.

## How it works

1. **Source.** war.gov/UFO loads its records from `https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-csv.csv`.
2. **Daily refresh.** A GitHub Action runs `scripts/fetch-csv.ts` every day. The script drives a stealth-patched Chromium (Akamai blocks plain HTTP clients) to grab the CSV, parses it, and merges into `data/records.json`.
3. **Merge rules:**
   - Records present in source are upserted (right-side wins).
   - Records that disappear from source are kept and flagged `removedFromSource: true` so nothing is lost from the public record.
   - Each record carries `firstSeenAt` and `lastSeenAt` ISO dates.
4. **Auto-deploy.** When `data/records.json` changes, the Action commits to `main`. Vercel auto-deploys on push.

## Full-text extraction

Each PDF is transcribed to text so the site can offer full-text search:

1. **`pnpm download:pdfs`** — Playwright stealth pulls every linked PDF to `data/_pdfs/<id>.pdf` (Akamai blocks plain HTTP). One-off; idempotent.
2. **`pnpm extract:text`** — runs `pdftotext` first; if the PDF is born-digital it returns clean text in <1s for free. Falls back to OpenAI vision (gpt-5.5) for scans. Set `PDFTOTEXT_ONLY=1` to do only the free passes.
3. **`pnpm extract:gemini`** — Gemini 2.5 Flash on rendered pages. Cheaper than OpenAI for vision-OCR. Used as the primary path for scanned docs.

Outputs:
- `data/text/<id>.txt` per record
- `data/records.json` is updated with `textChars`, `extractionPages`, `extractionModel`, `textExtractedAt`
- `pnpm prebuild` (auto on dev/build) materializes `public/text/` and `public/text-index.json` for the site

## Local dev

```bash
pnpm install
pnpm exec playwright install chromium   # one-time
echo "OPENAI_API_KEY=sk-..." > .env
echo "GOOGLE_API_KEY=AI..."  >> .env
pnpm dev                                # http://localhost:3000
pnpm fetch:csv                          # refresh data/records.json from war.gov
```

## Project layout

```
data/
  records.json           # merged dataset rendered by the site
  uap-csv.csv            # last raw CSV pulled from war.gov (debug aid)
  text/<id>.txt          # extracted full text per record
  _pdfs/<id>.pdf         # gitignored; populated by download-pdfs
scripts/
  fetch-csv.ts           # daily refresh / merge pipeline
  download-pdfs.ts       # Playwright stealth: pull every PDF to disk
  extract-text.ts        # pdftotext-first, OpenAI gpt-5.5 fallback
  extract-text-gemini.ts # Gemini 2.5 Flash, primary for scanned docs
  build-text-index.ts    # prebuild: copy data/text → public/, build search index
  verify-data.ts         # CI integrity check on records.json
src/
  app/page.tsx           # main page
  components/records-table.tsx
  lib/records.ts         # static-imports records.json + derives filter lists
.github/workflows/
  refresh-csv.yml        # daily cron: pull CSV → merge → commit
  extract-text.yml       # post-refresh: vision-OCR new PDFs (uses OPENAI_API_KEY)
  ci.yml                 # lint + verify-data + build on every push/PR
```

## Notes

- Unofficial, third-party mirror with no affiliation to the Department of War.
- Site is fully static — no runtime fetching from war.gov.
- A future enhancement would mirror the actual PDF / image / video files to Cloudflare R2 in case the source removes them. Tracked but not built.
