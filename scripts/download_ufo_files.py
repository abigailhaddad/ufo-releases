#!/usr/bin/env python3
"""
Download all UAP/UFO files listed at https://www.war.gov/UFO/

Strategy:
  1. Open the UFO page in Chrome (non-headless — Akamai blocks headless).
  2. Fetch the data CSV (uap-csv.csv) via the browser session so the CDN
     allows it.
  3. Parse the CSV to get every "PDF | Image Link" URL (161 records).
  4. Download each file via in-browser fetch() to base64, then save to disk.
     This re-uses the browser session, which is the only thing the CDN
     allows.
  5. Skip files that already exist locally.
  6. Route .pdf into data/_pdfs/ and everything else (images, video, audio)
     into data/_media/.

Run from the repo root so the relative `data/` path resolves correctly.
"""

import base64
import csv
import io
import re
import sys
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse, urljoin

import requests
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

UFO_PAGE = "https://www.war.gov/UFO/"
CSV_PATH = "/Portals/1/Interactive/2026/UFO/uap-csv.csv"
DATA_DIR = Path("data")
PDF_DIR = DATA_DIR / "_pdfs"
MEDIA_DIR = DATA_DIR / "_media"
URL_COLUMN = "PDF | Image Link"

DVIDS_BASE = "https://www.dvidshub.net"


def dest_dir_for(filename):
    """Route .pdf files to _pdfs/, everything else (images, video, audio) to _media/."""
    return PDF_DIR if filename.lower().endswith(".pdf") else MEDIA_DIR

# JS that runs in the page context, fetches a URL as a binary blob,
# and returns it base64-encoded so we can transfer it back to Python.
JS_DOWNLOAD = """
const url = arguments[0];
const cb = arguments[1];
fetch(url, {credentials:'include'})
  .then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.arrayBuffer();
  })
  .then(buf => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    cb({ok: true, b64: btoa(bin), size: bytes.length});
  })
  .catch(e => cb({ok: false, error: String(e)}));
"""

JS_FETCH_TEXT = """
const url = arguments[0];
const cb = arguments[1];
fetch(url, {credentials:'include'})
  .then(r => r.text())
  .then(t => cb(t))
  .catch(e => cb('ERR:' + e));
"""


def make_driver():
    opts = Options()
    # NOTE: headless mode is blocked by Akamai — run visible.
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--window-size=1280,900")
    driver = webdriver.Chrome(options=opts)
    driver.set_script_timeout(600)
    return driver


def build_requests_session(driver):
    """Copy cookies + UA from Selenium into a requests.Session for streaming downloads."""
    sess = requests.Session()
    ua = driver.execute_script("return navigator.userAgent;")
    sess.headers.update({
        "User-Agent": ua,
        "Accept": "*/*",
        "Referer": UFO_PAGE,
    })
    for c in driver.get_cookies():
        sess.cookies.set(c["name"], c["value"], domain=c.get("domain"), path=c.get("path", "/"))
    return sess


def download_via_requests(sess, url, dest, timeout=180):
    full = urljoin(UFO_PAGE, url)
    with sess.get(full, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        tmp = dest.with_suffix(dest.suffix + ".part")
        size = 0
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=64 * 1024):
                if chunk:
                    f.write(chunk)
                    size += len(chunk)
        tmp.rename(dest)
        return size


def parse_csv(text):
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    dvids_rows = []
    dropped = []
    for row in reader:
        url = (row.get(URL_COLUMN) or "").strip()
        title = (row.get("Title") or "").strip().replace("\n", " ")
        agency = (row.get("Agency") or "").strip()
        dvids_id = (row.get("DVIDS Video ID") or "").strip()
        if url:
            rows.append({"title": title, "url": url, "agency": agency})
            continue
        if dvids_id:
            dvids_rows.append({"title": title, "agency": agency, "dvids_id": dvids_id})
            continue
        dropped.append({"title": title, "agency": agency})
    return rows, dvids_rows, dropped


def slugify(text, max_len=120):
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("._-")
    return s[:max_len] or "file"


def filename_from_url(url):
    name = Path(urlparse(url).path).name or "file"
    return name


def assign_filenames(rows):
    """Pick a stable on-disk filename per row. If two URLs share a basename,
    disambiguate the colliding ones by prefixing the parent path segment.
    Non-colliding basenames keep their bare name so existing downloads stay valid."""
    basename_counts = Counter(filename_from_url(r["url"]) for r in rows)
    for r in rows:
        path = urlparse(r["url"]).path
        name = Path(path).name or "file"
        if basename_counts[name] > 1:
            parts = [s for s in path.split("/") if s]
            parent = parts[-2] if len(parts) >= 2 else ""
            if parent:
                name = f"{parent}__{name}"
        r["filename"] = name
    return rows


def build_dvids_session(driver):
    """Mirror of build_requests_session but for the DVIDS domain.

    Driver must be on a dvidshub.net page so its cookies (PHPSESSID etc.)
    are visible to driver.get_cookies().
    """
    sess = requests.Session()
    ua = driver.execute_script("return navigator.userAgent;")
    sess.headers.update({
        "User-Agent": ua,
        "Accept": "*/*",
        "Referer": DVIDS_BASE + "/",
    })
    for c in driver.get_cookies():
        sess.cookies.set(c["name"], c["value"], domain=c.get("domain"), path=c.get("path", "/"))
    return sess


def fetch_dvids_embed_mp4(driver, video_id):
    """Return the public CloudFront .mp4 URL exposed by the embed player.

    DVIDS now requires login for /download/videofile/<id> ("You must be logged
    in to download"), but the embed iframe at /video/embed/<id> still serves a
    public CloudFront URL of comparable quality with no auth.
    """
    embed_path = f"/video/embed/{video_id}"
    html = driver.execute_async_script(JS_FETCH_TEXT, embed_path)
    if not isinstance(html, str) or html.startswith("ERR:"):
        raise RuntimeError(f"embed fetch failed: {html!r}")
    m = re.search(r'https?://[^"\' ]+\.mp4[^"\' ]*', html)
    if not m:
        raise RuntimeError("no .mp4 URL in embed HTML")
    return m.group(0)


def download_dvids_one(driver, row, dest):
    """Find the public CloudFront .mp4 via the embed page and download it.
    Returns (status, info, via)."""
    if dest.exists() and dest.stat().st_size > 0:
        return "skip", dest.stat().st_size, None

    video_id = row["dvids_id"]
    page_url = f"{DVIDS_BASE}/video/{video_id}"
    driver.get(page_url)
    time.sleep(2)

    try:
        mp4_url = fetch_dvids_embed_mp4(driver, video_id)
    except Exception as e:
        return "err", f"embed: {e}", None

    sess = build_dvids_session(driver)
    sess.headers["Referer"] = page_url

    try:
        with sess.get(mp4_url, stream=True, timeout=600, allow_redirects=True) as r:
            r.raise_for_status()
            tmp = dest.with_suffix(dest.suffix + ".part")
            size = 0
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        f.write(chunk)
                        size += len(chunk)
            tmp.rename(dest)
            return "ok", size, "requests"
    except Exception as e:
        requests_err = str(e)

    try:
        result = driver.execute_async_script(JS_DOWNLOAD, mp4_url)
        if not isinstance(result, dict) or not result.get("ok"):
            err = (result or {}).get("error", "unknown")
            return "err", f"requests:{requests_err} | js:{err}", None
        data = base64.b64decode(result["b64"])
        dest.write_bytes(data)
        return "ok", len(data), "js"
    except Exception as e:
        return "err", f"requests:{requests_err} | js:{e}", None


def download_one(driver, sess, url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return "skip", dest.stat().st_size, None

    # Primary: stream via requests with the browser's cookies. Avoids the
    # base64-through-JS round-trip that times out on large files.
    try:
        size = download_via_requests(sess, url, dest)
        return "ok", size, "requests"
    except Exception as e:
        requests_err = str(e)

    # Fallback: original JS-fetch path. Refresh session if needed.
    try:
        result = driver.execute_async_script(JS_DOWNLOAD, url)
        if not isinstance(result, dict) or not result.get("ok"):
            err = (result or {}).get("error", "unknown")
            return "err", f"requests:{requests_err} | js:{err}", None
        data = base64.b64decode(result["b64"])
        dest.write_bytes(data)
        return "ok", len(data), "js"
    except Exception as e:
        return "err", f"requests:{requests_err} | js:{e}", None


def main():
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    driver = make_driver()
    try:
        print(f"Loading {UFO_PAGE} ...")
        driver.get(UFO_PAGE)
        time.sleep(4)  # let page fully render & cookies settle

        print(f"Fetching {CSV_PATH} via browser session ...")
        csv_text = driver.execute_async_script(JS_FETCH_TEXT, CSV_PATH)
        if csv_text.startswith("ERR:"):
            print(f"Failed to fetch CSV: {csv_text}")
            return 1
        print(f"  CSV size: {len(csv_text)} bytes")

        rows, dvids_rows, dropped = parse_csv(csv_text)
        print(f"  parsed {len(rows)} records with direct download URLs")
        print(f"  parsed {len(dvids_rows)} DVIDS-only video/audio records")
        if dropped:
            print(f"  {len(dropped)} rows had no URL and no DVIDS ID:")
            for d in dropped:
                agency = f" [{d['agency']}]" if d["agency"] else ""
                print(f"    - {d['title'] or '(no title)'}{agency}")
        print()

        if not rows and not dvids_rows:
            print("No records found. Inspect the CSV columns.")
            return 1

        rows = assign_filenames(rows)
        collisions = sum(1 for r in rows if "__" in r["filename"])
        if collisions:
            print(f"  {collisions} URLs had basename collisions; disambiguated with parent path segment.\n")

        sess = build_requests_session(driver)

        ok = skipped = errored = 0
        total_bytes = 0
        failed = []
        for i, row in enumerate(rows, 1):
            url = row["url"]
            name = row["filename"]
            dest = dest_dir_for(name) / name
            status, info, via = "err", "init", None
            for attempt in range(3):
                try:
                    status, info, via = download_one(driver, sess, url, dest)
                except Exception as e:
                    status, info, via = "err", str(e), None
                if status != "err":
                    break
                time.sleep(2 * (attempt + 1))
                # Refresh cookies before retrying — Akamai may have rotated them.
                sess = build_requests_session(driver)

            if status == "ok":
                ok += 1
                total_bytes += info
                tag = f" via {via}" if via else ""
                print(f"  [{i:3d}/{len(rows)}] ok    {name}  ({info/1024:.1f} KB){tag}")
            elif status == "skip":
                skipped += 1
                print(f"  [{i:3d}/{len(rows)}] skip  {name}")
            else:
                errored += 1
                failed.append((name, info))
                print(f"  [{i:3d}/{len(rows)}] ERR   {name}  -- {info}")

        if dvids_rows:
            print(f"\nDownloading {len(dvids_rows)} DVIDS video/audio files ...")
            for i, row in enumerate(dvids_rows, 1):
                name = f"{slugify(row['title'])}__dvids{row['dvids_id']}.mp4"
                dest = dest_dir_for(name) / name
                status, info, via = "err", "init", None
                for attempt in range(3):
                    try:
                        status, info, via = download_dvids_one(driver, row, dest)
                    except Exception as e:
                        status, info, via = "err", str(e), None
                    if status != "err":
                        break
                    time.sleep(2 * (attempt + 1))

                if status == "ok":
                    ok += 1
                    total_bytes += info
                    tag = f" via {via}" if via else ""
                    print(f"  [{i:3d}/{len(dvids_rows)}] ok    {name}  ({info/1024/1024:.1f} MB){tag}")
                elif status == "skip":
                    skipped += 1
                    print(f"  [{i:3d}/{len(dvids_rows)}] skip  {name}")
                else:
                    errored += 1
                    failed.append((name, info))
                    print(f"  [{i:3d}/{len(dvids_rows)}] ERR   {name}  -- {info}")

        print(f"\nDone. ok={ok} skipped={skipped} errored={errored} "
              f"total={total_bytes/1024/1024:.1f} MB -> {PDF_DIR}/ + {MEDIA_DIR}/")
        if failed:
            print("\nFailures:")
            for name, info in failed:
                print(f"  {name}: {info}")
        return 0 if errored == 0 else 2
    finally:
        driver.quit()


if __name__ == "__main__":
    sys.exit(main())
