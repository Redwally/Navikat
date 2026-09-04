#!/bin/sh
echo "[Navikat] Updating yt-dlp at startup..."
pip install -U yt-dlp --break-system-packages 2>/dev/null || pip install -U yt-dlp || true
exec "$@"
