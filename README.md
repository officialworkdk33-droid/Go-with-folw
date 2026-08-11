# HAWB Document Merger — Full Stack

Scans a batch of mixed documents (PDF, DOCX/DOC, XLSX/XLS, CSV/TXT, scanned images),
finds the House Airway Bill (HAWB) number referenced in each one, groups matching
documents into per‑shipment subfolders, and merges each subfolder into one named PDF.

Runs entirely on your own machine — no files are sent to any third party.

```
hawb-fullstack/
├── backend/            FastAPI server: extraction, matching, merging, zipping
│   ├── main.py          API routes + serves the frontend
│   ├── processing.py    Text extraction / HAWB regex / PDF merge logic
│   └── requirements.txt
├── frontend/            Plain HTML/CSS/JS UI (no build step needed)
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── run.sh               One-command start (creates a venv on first run)
```

## Requirements

- Python 3.9+
- **Tesseract OCR** installed system-wide, only needed if you have scanned image
  documents to read:
  - macOS: `brew install tesseract`
  - Ubuntu/Debian: `sudo apt-get install tesseract-ocr`
  - Windows: install from https://github.com/UB-Mannheim/tesseract/wiki, then make
    sure `tesseract.exe` is on your PATH.

## Run it

```bash
chmod +x run.sh
./run.sh
```

Then open **http://127.0.0.1:8000** in your browser.

(If you'd rather set it up manually: `cd backend && python3 -m venv .venv &&
.venv/bin/pip install -r requirements.txt && .venv/bin/uvicorn main:app --port 8000`.)

## Using the app

1. **Step 1 — Common name.** A label combined with each shipment's HAWB to name the
   merged PDF, e.g. `ACME-INVOICES_HAB99381273.pdf`.
2. **Step 2 — Point at the documents.** Either:
   - Type a folder path that exists **on the machine running this server**
     (e.g. `/Users/you/Documents/incoming-shipments`) — the backend walks it directly, or
   - Upload files, or drag a folder from your device into the drop zone.
   You can use both at once.
3. **Scan & Match.** The server reads every file (OCR for images), searches for a
   HAWB number, and groups files that resolve to the same number.
4. **Step 3 — Review.** Each card is one shipment / subfolder. If a match looks
   wrong (OCR misreads a character, a document uses an unusual label, etc.), edit
   the code shown under that file — it will move to whichever folder you type.
5. **Step 4 — Build & Download.** Produces a ZIP: one subfolder per HAWB, each
   containing the original matched files **and** one merged PDF.

## How matching works

`backend/processing.py` looks for, in priority order:
1. A label like "House Airway Bill", "HAWB", "H.A.W.B.", "HBL" followed by a
   number/code.
2. A generic "AWB" label followed by a number/code.
3. A Master-AWB-style pattern (`nnn-nnnnnnnn`).
4. A number-like token in the filename itself.

Codes are normalized (punctuation stripped, uppercased) before grouping, so the
same HAWB written as `88213/AX`, `88213-AX`, or `88213 AX` in different documents
still collapses into a single shipment folder.

If your documents use a HAWB format or label wording these patterns miss, send a
sample and the regexes in `processing.py` can be tuned.

## How merging works

- **PDF** source pages are copied in at full quality (no re-rendering).
- **Images** (scans) are placed as a full page in the merged PDF.
- **DOCX / XLSX / CSV / TXT / legacy DOC**, and anything that fails to process,
  are rendered as formatted text pages in the merged PDF — the original file is
  always kept in its subfolder regardless, so nothing is lost even if the merged
  preview isn't pixel-perfect.

## Hosting it online

The app ships with a `Dockerfile` (installs Tesseract + Python deps in the
image) so it runs the same way locally and in the cloud. It will **not** run
on Vercel — Vercel is for static sites / Next.js / short-lived serverless
functions, and this app is a normal long-running server that needs a real
OCR binary and a filesystem between requests.

### Deploy to Render (recommended, has a free/starter tier)

1. Push this folder to a GitHub repo.
2. On https://render.com → **New → Web Service** → connect that repo.
   Render will detect the `Dockerfile` automatically (or use the included
   `render.yaml` via **New → Blueprint** for one-click setup of the env vars
   below).
3. Set environment variables in the Render dashboard:
   - `APP_ACCESS_CODE` — **set this** to a password of your choosing. Without
     it, anyone with your Render URL can use the app (and burn your OCR
     compute). The frontend will prompt for this code automatically once set.
   - `ALLOW_FOLDER_SCAN` — leave as `false`. This only makes sense when
     running locally for yourself; on a public server, letting visitors type
     an arbitrary filesystem path is a real security risk, so it is refused
     unless you explicitly turn it on (don't, on a shared deployment).
   - `MAX_UPLOAD_MB` / `MAX_FILES_PER_SCAN` — optional caps, defaults are
     150MB / 150 files per scan.
   - `SESSION_TTL_HOURS` — how long an uploaded batch stays on disk before
     automatic cleanup (default 6 hours).
4. Deploy. Render gives you a URL like `https://hawb-document-merger.onrender.com`.

Notes for Render specifically:
- The free/starter instance's disk is **ephemeral** — sessions won't survive
  a redeploy or a restart after inactivity. That's fine for this app's
  workflow (scan → review → build → download, all in one sitting). If you
  need sessions to persist longer, attach a Render **persistent disk** at
  `/data` (the Dockerfile already points `HAWB_SESSIONS_DIR` there).
- Cold starts on the free tier can take ~30–60s for the first request after
  idling — the OCR/PDF libraries are heavy to import.

### Other platforms

Any host that runs a `Dockerfile` works the same way: **Railway**, **Fly.io**,
a plain VM, etc. They all read the same environment variables above and the
same `CMD` in the Dockerfile (`$PORT` is honored automatically).

### Security checklist before sharing the URL

- [ ] `APP_ACCESS_CODE` is set to something only you and intended users know
- [ ] `ALLOW_FOLDER_SCAN` is left `false`
- [ ] You're comfortable that uploaded documents (which may contain business
      data) sit in the host's temp storage for up to `SESSION_TTL_HOURS`
