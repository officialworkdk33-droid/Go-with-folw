import json
import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from processing import (
    SUPPORTED_EXTS,
    build_merged_pdf,
    detect_hawb,
    extract_text,
    get_ext,
    sanitize_name,
)

# ---------------------------------------------------------------------------
# Configuration (all overridable via environment variables)
# ---------------------------------------------------------------------------
BASE_DIR = Path(os.environ.get("HAWB_SESSIONS_DIR", tempfile.gettempdir())) / "hawb_sessions"
BASE_DIR.mkdir(parents=True, exist_ok=True)

# The "scan a folder path on the server" feature is only safe when you and the
# server share a filesystem, i.e. running this locally for yourself. On a public
# deployment it would let any visitor read arbitrary files off the host, so it
# is OFF unless explicitly enabled.
ALLOW_FOLDER_SCAN = os.environ.get("ALLOW_FOLDER_SCAN", "false").lower() == "true"

# Optional shared access code. If set, every /api/scan and /api/build request
# must include a matching X-Access-Code header. Leave unset to allow anyone
# with the URL to use the app.
APP_ACCESS_CODE = os.environ.get("APP_ACCESS_CODE", "").strip()

MAX_FILES_PER_SCAN = int(os.environ.get("MAX_FILES_PER_SCAN", "150"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "150"))
SESSION_TTL_HOURS = float(os.environ.get("SESSION_TTL_HOURS", "6"))

app = FastAPI(title="HAWB Document Merger")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_access_code(x_access_code: Optional[str] = Header(None)):
    if APP_ACCESS_CODE and x_access_code != APP_ACCESS_CODE:
        raise HTTPException(401, "Missing or incorrect access code")


def session_dir(session_id: str) -> Path:
    # session_id comes from uuid4().hex — reject anything else before it
    # ever touches a filesystem path.
    if not session_id.isalnum():
        raise HTTPException(400, "Invalid session id")
    d = BASE_DIR / session_id
    if not d.exists():
        raise HTTPException(404, "Session not found or expired")
    return d


def unique_path(folder: Path, filename: str) -> Path:
    filename = Path(filename).name  # strip any path components
    dest = folder / filename
    if not dest.exists():
        return dest
    stem, ext = os.path.splitext(filename)
    i = 1
    while (folder / f"{stem}__{i}{ext}").exists():
        i += 1
    return folder / f"{stem}__{i}{ext}"


def cleanup_old_sessions():
    cutoff = time.time() - SESSION_TTL_HOURS * 3600
    try:
        for child in BASE_DIR.iterdir():
            try:
                if child.is_dir() and child.stat().st_mtime < cutoff:
                    shutil.rmtree(child, ignore_errors=True)
            except Exception:
                pass
    except Exception:
        pass


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/config")
def config():
    """Lets the frontend know which optional features are enabled."""
    return {
        "allow_folder_scan": ALLOW_FOLDER_SCAN,
        "access_code_required": bool(APP_ACCESS_CODE),
        "max_files_per_scan": MAX_FILES_PER_SCAN,
        "max_upload_mb": MAX_UPLOAD_MB,
    }


@app.post("/api/scan", dependencies=[Depends(require_access_code)])
async def scan(
    files: Optional[List[UploadFile]] = File(None),
    folder_path: Optional[str] = Form(None),
):
    cleanup_old_sessions()

    if folder_path and not ALLOW_FOLDER_SCAN:
        raise HTTPException(
            403,
            "Server-side folder scanning is disabled on this deployment. Upload files instead.",
        )

    session_id = uuid.uuid4().hex
    sdir = BASE_DIR / session_id
    incoming = sdir / "incoming"
    cache = sdir / "textcache"
    incoming.mkdir(parents=True)
    cache.mkdir(parents=True)

    collected = []
    total_bytes = 0
    max_bytes = MAX_UPLOAD_MB * 1024 * 1024

    if folder_path:
        src = Path(folder_path).expanduser()
        if not src.exists() or not src.is_dir():
            shutil.rmtree(sdir, ignore_errors=True)
            raise HTTPException(400, f"Folder not found on server: {folder_path}")
        for root, _dirs, fnames in os.walk(src):
            for fn in fnames:
                ext = get_ext(fn)
                if ext in SUPPORTED_EXTS:
                    if len(collected) >= MAX_FILES_PER_SCAN:
                        break
                    full = Path(root) / fn
                    try:
                        size = full.stat().st_size
                        if total_bytes + size > max_bytes:
                            continue
                        dest = unique_path(incoming, fn)
                        shutil.copy2(full, dest)
                        collected.append(dest)
                        total_bytes += size
                    except Exception:
                        pass

    if files:
        for uf in files:
            if not uf.filename:
                continue
            if len(collected) >= MAX_FILES_PER_SCAN:
                break
            ext = get_ext(uf.filename)
            if ext not in SUPPORTED_EXTS:
                continue
            content = await uf.read()
            total_bytes += len(content)
            if total_bytes > max_bytes:
                shutil.rmtree(sdir, ignore_errors=True)
                raise HTTPException(413, f"Upload too large (limit {MAX_UPLOAD_MB} MB total).")
            dest = unique_path(incoming, Path(uf.filename).name)
            dest.write_bytes(content)
            collected.append(dest)

    if not collected:
        shutil.rmtree(sdir, ignore_errors=True)
        raise HTTPException(400, "No supported files found (checked folder_path and uploads).")

    results = []
    meta = {"files": [], "created": time.time()}
    for i, path in enumerate(collected):
        ext = get_ext(path.name)
        text = extract_text(path, ext)
        (cache / f"f{i}.txt").write_text(text, errors="ignore")
        key = detect_hawb(text, path.name) or "UNSORTED"
        entry = {
            "id": f"f{i}",
            "name": path.name,
            "ext": ext,
            "key": key,
            "size": path.stat().st_size,
        }
        results.append(entry)
        meta["files"].append(entry)

    (sdir / "meta.json").write_text(json.dumps(meta))

    return {"session_id": session_id, "files": results, "source": "folder" if folder_path else "upload"}


class BuildAssignment(BaseModel):
    id: str
    key: str


class BuildRequest(BaseModel):
    session_id: str
    common_name: str
    assignments: List[BuildAssignment]


@app.post("/api/build", dependencies=[Depends(require_access_code)])
def build(req: BuildRequest):
    sdir = session_dir(req.session_id)
    incoming = sdir / "incoming"
    cache = sdir / "textcache"
    meta_path = sdir / "meta.json"
    if not meta_path.exists():
        raise HTTPException(400, "Session has no scanned files")
    meta = json.loads(meta_path.read_text())
    by_id = {f["id"]: f for f in meta["files"]}

    if not req.common_name.strip():
        raise HTTPException(400, "common_name is required")

    groups = {}
    for a in req.assignments:
        f = by_id.get(a.id)
        if not f:
            continue
        key = (a.key or "UNSORTED").strip().upper() or "UNSORTED"
        groups.setdefault(key, []).append(f)

    if not groups:
        raise HTTPException(400, "No files to build")

    output_dir = sdir / "output"
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir()

    common = sanitize_name(req.common_name)
    build_log = []

    def log(msg, err=False):
        build_log.append({"msg": msg, "err": err})

    summary = []
    for key, flist in groups.items():
        folder_name = sanitize_name(key)
        folder = output_dir / folder_name
        folder.mkdir(parents=True, exist_ok=True)

        merge_inputs = []
        for f in flist:
            src = incoming / f["name"]
            dst = folder / f["name"]
            if src.exists():
                shutil.copy2(src, dst)
            text = ""
            txt_cache = cache / f"{f['id']}.txt"
            if txt_cache.exists():
                text = txt_cache.read_text(errors="ignore")
            merge_inputs.append({"path": dst, "name": f["name"], "ext": f["ext"], "text": text})

        merged_name = f"{common}_{folder_name}.pdf"
        merged_path = folder / merged_name
        build_merged_pdf(merge_inputs, merged_path, log=log)
        summary.append({"key": key, "folder": folder_name, "file_count": len(flist), "merged_name": merged_name})

    zip_base = sdir / "shipments"
    zip_path_str = shutil.make_archive(str(zip_base), "zip", root_dir=str(output_dir))
    zip_path = Path(zip_path_str)

    return {
        "session_id": req.session_id,
        "groups": summary,
        "log": build_log,
        "download_url": f"/api/download/{req.session_id}",
        "zip_size": zip_path.stat().st_size,
    }


@app.get("/api/download/{session_id}")
def download(session_id: str):
    sdir = session_dir(session_id)
    zip_path = sdir / "shipments.zip"
    if not zip_path.exists():
        raise HTTPException(404, "Build the shipments first (POST /api/build)")
    return FileResponse(str(zip_path), filename="shipments.zip", media_type="application/zip")


@app.delete("/api/session/{session_id}")
def delete_session(session_id: str):
    sdir = BASE_DIR / session_id
    if sdir.exists():
        shutil.rmtree(sdir, ignore_errors=True)
    return {"deleted": True}


# Serve the frontend (static files) at "/"
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
