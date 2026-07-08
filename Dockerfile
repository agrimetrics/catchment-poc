# syntax=docker/dockerfile:1
#
# Self-contained image for the Poole Harbour catchment demonstrator. Serves the whole app from one
# origin: static frontend (with vendored JS/CSS — no external CDN), the SPARQL endpoint over an
# in-memory Oxigraph store rebuilt from the committed .ttl on boot, a same-origin basemap-tile proxy,
# and a same-origin proxy to the EA Water Quality Archive for observations.
#
#   docker build -t catchment-poc .
#   docker run --rm -p 8000:8000 catchment-poc      # then open http://localhost:8000
#
# The container needs outbound egress to environment.data.gov.uk (observations) and the tile source;
# override EA_BASE / TILE_BASE to route those through a platform proxy. Disk caches live in CACHE_DIR
# (a writable temp path), never in the app tree.

FROM python:3.13-slim

# pyoxigraph is the only runtime dependency — the HTTP server and store loading are stdlib. Wheels
# are prebuilt (manylinux), so no build toolchain is needed.
RUN pip install --no-cache-dir "pyoxigraph>=0.5.0,<0.6.0"

WORKDIR /app
COPY . .

# Non-root user; caches go to a writable dir OUTSIDE the app tree (keeps downloaded data out of the
# source and lets the image run read-only if desired, with CACHE_DIR mounted as a volume).
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /var/cache/catchment \
    && chown appuser /var/cache/catchment
USER appuser

ENV HOST=0.0.0.0 \
    PORT=8000 \
    CACHE_DIR=/var/cache/catchment
EXPOSE 8000

# Healthcheck: the home page returns 200 once the store has finished loading.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8000')+'/').status==200 else 1)"]

CMD ["python", "app/server.py"]
