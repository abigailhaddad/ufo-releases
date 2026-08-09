# UAP / UFO Release Index

Searchable, sortable mirror of the declassified UAP records the U.S. Department of War publishes at [war.gov/UFO](https://www.war.gov/UFO/).

The official site is JS-heavy and inconvenient to browse, so this site reads the same source CSV they ship and renders it as a normal table — with chip-style filters, full-text search across every PDF, and match highlighting.

> **What we host vs. what we link.** The metadata table (titles, descriptions, agencies, dates) and the AI-transcribed PDF text are mirrored locally and shipped with the site. The actual source files (PDFs / images / videos) are uploaded to a public Cloudflare R2 bucket — `https://pub-a5fc1ae0b89944dba0ab60286076ab1e.r2.dev/<key>` — and the table also links to the originals on `war.gov` / `dvidshub.net` so you can verify provenance.

## How it works

1. **Source.** war.gov/UFO loads its records from `https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-csv.csv`.
2. **Daily refresh.** A GitHub Action runs `scripts/fetch-csv.ts` daily. The script drives a stealth-patched Chromium (Akamai blocks plain HTTP clients) to grab the CSV, parses it, and merges into `data/records.json`.
3. **Merge rules:**
   - Records present in source are upserted (right-side wins on overlap).
   - Records that disappear from source are kept and flagged `removedFromSource: true`.
   - Each record carries `firstSeenAt` and `lastSeenAt` ISO dates.
   - Match key is `agency::type::fileUrl` so cosmetic title renames (e.g. war.gov rewriting "Persian Gulf" → "Arabian Gulf") don't get treated as a record disappearing + a new one appearing.
4. **Daily extract pipeline** (also in CI): downloads any new PDFs/media → tries `pdftotext` → falls back to a vision model for scans → verifies integrity → e2e tests → builds and publishes to Cloudflare Pages if everything passes.

## Full-text extraction

Each PDF is transcribed to text so the site can offer full-text search. The pipeline tries cheap-then-expensive:

1. **`pnpm download:pdfs`** — Playwright stealth pulls every linked PDF to `data/_pdfs/<id>.pdf` (Akamai blocks plain HTTP). Idempotent.
2. **`pnpm download:media`** — same but for IMG records (war.gov) + VID records (DVIDS, via the public CloudFront URL exposed in the embed iframe). Output goes to `data/_media/`.
3. **`pnpm extract:text`** — runs `pdftotext` first; born-digital PDFs come back clean in <1s for $0. With `PDFTOTEXT_ONLY=1` it skips the vision fallback.
4. **`pnpm extract:gemini`** — the vision-model fallback for scans. **Gemini 2.5 Flash** is the current default. We initially used OpenAI gpt-5.5 (~$80 spent extracting 8 records before we noticed); switched to Gemini Flash, which is roughly **10× cheaper for similar-quality OCR on this corpus** and ran the remaining ~110 records for a few dollars total. The OpenAI script (`scripts/extract-text.ts`) still exists for fallback.
5. **`pnpm upload:r2`** — mirrors `data/_pdfs/`, `data/_media/`, `data/text/` to the public R2 bucket via `wrangler`. Skip-if-exists.

Outputs / state:
- `data/text/<id>.txt` — extracted full text per record (committed; ~6MB)
- `data/records.json` updated with `textChars`, `extractionPages`, `extractionModel`, `textExtractedAt`
- `pnpm prebuild` (auto on dev/build) materializes `public/text/` and `public/text-index.json` (lowercased) so the table can lazy-load the search index in the browser.

The table searches across record metadata AND the full extracted text simultaneously — every chip filter must match somewhere in either.

## Local dev

```bash
pnpm install
pnpm exec playwright install chromium   # one-time
cat > .env <<EOF
GOOGLE_API_KEY=AI...                   # Gemini, paid tier ($ tiny per run)
OPENAI_API_KEY=sk-...                  # optional fallback
CLOUDFLARE_API_TOKEN=cfut_...          # only for pnpm upload:r2
CLOUDFLARE_ACCOUNT_ID=...
EOF
pnpm dev                                # http://localhost:3000
pnpm fetch:csv                          # refresh data/records.json from war.gov
pnpm test:e2e                           # Playwright tests against `next start`
```

## Project layout

```
data/
  records.json             # merged dataset rendered by the site
  uap-csv.csv              # last raw CSV pulled from war.gov (debug aid)
  text/<id>.txt            # extracted full text per record (committed)
  summaries/<id>.md        # markdown per-record summaries (Will's skill, optional)
  _pdfs/<id>.pdf           # gitignored; populated by download:pdfs
  _media/<id>.<ext>        # gitignored; populated by download:media
scripts/
  fetch-csv.ts             # daily refresh / merge pipeline
  download-pdfs.ts         # Playwright stealth: pull every PDF to disk
  download-media.ts        # same but for images + DVIDS videos
  download_ufo_files.py    # Python alternative (Selenium) — equivalent
  extract-text.ts          # pdftotext-first, OpenAI fallback (legacy path)
  extract-text-gemini.ts   # primary: Gemini 2.5 Flash on scans
  build-text-index.ts      # prebuild: copy data/text → public/, build search index
  upload-to-r2.ts          # mirror everything to public R2 bucket
  verify-data.ts           # data integrity + reversion checks for CI
src/
  app/page.tsx             # main page
  components/records-table.tsx  # chip-filter table + modal w/ highlighting
  lib/records.ts           # static-imports records.json + derives filter lists
.claude/skills/
  summarize-records/       # Will's skill: parallel subagents → data/summaries/
e2e/
  records-table.spec.ts    # Playwright tests against next start
.github/workflows/
  refresh-csv.yml          # daily cron: pull CSV → merge → commit
  extract-text.yml         # post-refresh: download → pdftotext → Gemini →
                           #   verify → build → e2e → R2 → Pages deploy
  ci.yml                   # lint + verify-data + build + e2e on every push/PR
```

## Notes

- Unofficial, third-party mirror with no affiliation to the Department of War.
- Site is fully static — no runtime fetching from war.gov.
- The live site is **`main`**, deployed to Cloudflare Pages — by `deploy.yml` on human pushes, and by the pipeline's own deploy step on bot pushes (GitHub does not fire workflows for `GITHUB_TOKEN` commits). `verify-data` and the e2e suite gate the publish.
- **`prod`** is retained but no longer tracks `main`. It only feeds a Vercel project reduced to a redirect stub, so the legacy `ufo-releases.vercel.app` hostname keeps forwarding to `ufo-releases.abigailhaddad.com` — that is what `vercel.json` is for. Don't delete the branch.

## Media/Python alternative

`scripts/download_ufo_files.py` is Will's Selenium-based equivalent of `download-pdfs.ts` + `download-media.ts`. We keep both paths so contributors can pick their stack.

**NOTE**: This will download ~3 GB of files.

```bash
pip install -r python-requirements.txt
python scripts/download_ufo_files.py
```
