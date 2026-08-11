FROM python:3.12-slim

# Tesseract is required for OCR on scanned image documents.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend backend
COPY frontend frontend

# Sessions (temp uploads/output) live here — mount a persistent disk at this
# path on your host if you want sessions to survive a redeploy/restart.
ENV HAWB_SESSIONS_DIR=/data
RUN mkdir -p /data

EXPOSE 8000
WORKDIR /app/backend

# Render/Railway/Fly inject $PORT; default to 8000 for plain `docker run`.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
