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

## Local dev

```bash
pnpm install
pnpm exec playwright install chromium   # one-time
pnpm dev                                # http://localhost:3000
pnpm fetch:csv                          # refresh data/records.json from war.gov
```

## Project layout

```
data/
  records.json           # merged dataset rendered by the site
  uap-csv.csv            # last raw CSV pulled from war.gov (debug aid)
scripts/
  fetch-csv.ts           # daily refresh / merge pipeline
src/
  app/page.tsx           # main page
  components/records-table.tsx
  lib/records.ts         # static-imports records.json + derives filter lists
.github/workflows/
  refresh-csv.yml        # daily cron
```

## Notes

- Unofficial, third-party mirror with no affiliation to the Department of War.
- Site is fully static — no runtime fetching from war.gov.
- A future enhancement would mirror the actual PDF / image / video files to Cloudflare R2 in case the source removes them. Tracked but not built.


## Media/Python alternative:

`scripts/download_ufo_files.py` pulls every PDF / image / DVIDS video referenced by the CSV. The site itself does not depend on these — it's only useful if you want a local archive (a future R2 mirror would be built from this).

**NOTE**: This will download 3113.9 MB of files as of 2026-05-08

It drives a visible Chrome window (Akamai blocks headless) via Selenium, then streams each file with the browser's cookies. Output is split by type:

- `data/_pdfs/` — every `.pdf`
- `data/_media/` — images, DVIDS `.mp4`, etc.

Existing files are skipped, so re-runs are incremental.

```bash
pip install -r python-requirements.txt   # one-time: selenium + requests
# Chrome must be installed; selenium-manager ~should~ fetch the matching chromedriver.
python scripts/download_ufo_files.py     # run from the repo root
```