<p align="center">
  <img src="assets/images/logo.svg" width="300" alt="Navikat logo">
</p>

# Navikat — Deezer/Spotify/YouTube Music Downloader & Auto-Tagger for Navidrome

Navikat is a self-hosted web application that fetches music tracks and playlists from Deezer, Spotify, YouTube, and CSV exports, downloads high-quality 320kbps audio, and embeds complete metadata, HD covers, and synchronized lyrics directly into your Navidrome music library. It automatically handles file naming, organization, deduplication, and triggers a Navidrome library scan once downloads finish.


---

## 🚀 Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/redwally/navikat.git
   cd navikat
   ```

2. **Configure environment:**
   Copy `.env.example` to `.env` and fill in your values (see [Configuration](#-configuration) below for what each variable does).
   ```bash
   cp .env.example .env
   ```

3. **Set your music library path:**
   In `.env`, set `MUSIC_HOST_PATH` to the real folder on your host machine where your music library lives — no need to edit `docker-compose.yml` at all, it already reads this variable.
   ```dotenv
   MUSIC_HOST_PATH=/path/to/your/actual/music/folder
   ```

4. **Start the container:**
   ```bash
   docker compose up -d --build
   ```

5. **Open Navikat:**
   Navigate to `http://localhost:<HOST_PORT>` (default [http://localhost:3000](http://localhost:3000)) in your web browser.

---

## ⚙️ Configuration

All configuration lives in `.env`:

| Variable | Required | Description |
|---|---|---|
| `HOST_PORT` | No | Port exposed on your host machine (default `3000`). Change this if the port is already taken. |
| `TRUST_PROXY` | No | Enable (`true`) only if you have login/session issues behind a reverse proxy or tunnel (nginx, Cloudflare Tunnel, Traefik, etc.). Defaults to `false` — test with the default first. |
| `MUSIC_LIBRARY_PATH` | No | Internal container path for the music library. Leave as `/music` — don't change this. |
| `MUSIC_HOST_PATH` | Yes | Real path on your host machine to your Navidrome music folder. This is what actually gets mounted into the container. |
| `MAX_CONCURRENT_DOWNLOADS` | No | How many downloads run in parallel (default `3`). |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | No | Needed only to enable Spotify search/import. Get them from the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). |
| `ENABLE_AUTH` | No | Set to `true` to password-protect the site (default `false`). |
| `AUTH_PASSWORD` | If `ENABLE_AUTH=true` | The login password. |
| `SESSION_SECRET` | If `ENABLE_AUTH=true` | Random secret string used to sign session cookies — change it from the default. |
| `NAVIDROME_URL` / `NAVIDROME_USER` / `NAVIDROME_PASSWORD` | No | Optional — enables automatic library rescan and playlist creation in Navidrome after downloads finish. |
| `DEBUG` | No | Set to `true` for verbose logging (default `false`). |

---

## 📥 Import Methods

- **Search:** Use the main search bar to search across millions of tracks on Deezer (or Spotify when configured). Click the `+` button on any track result to fetch metadata, lyrics, and start downloading immediately.
- **YouTube Link:** Paste a direct YouTube video URL into the direct import field to download that specific audio stream. Navikat automatically cleans video titles, fetches matched HD covers and metadata, and embeds synchronized lyrics.
- **Playlist Link:** Paste a Deezer, Spotify, or YouTube playlist/album URL into the import box to batch-enqueue every track in the playlist with concurrent download management and deduplication against your library.
- **CSV Import:** Drag and drop a `.csv` playlist export (from TuneMyMusic, Spotify, or Deezer) directly onto the import input area or click the 📁 button to browse. Navikat parses the tracks, prioritizes exact platform IDs and ISRC codes, and enqueues all matched songs automatically.

---

## 🎛️ Queue Panel & Review

The collapsible corner download queue displays real-time progress bars, track metadata, and current status for all active and pending downloads. You can pause or resume the queue at any time, cancel individual jobs, or stop all downloads with one click. If a track's audio match fails confidence thresholds during a batch import, a brutalist review modal lets you pick from top YouTube candidates or skip the track. When a playlist import completes, an in-queue confirmation card allows you to create a matching playlist in Navidrome with a single click.

---

## 📸 Screenshots

### Main Interface & Search
![Main Screen](assets/screenshots/01_main_screen.png)

### Download Queue Panel
![Queue Panel](assets/screenshots/02_queue_panel.png)

### Unmatched Tracks Review Modal
![Batch Review](assets/screenshots/03_batch_review.png)

### Minimalist Login
![Login Screen](assets/screenshots/04_login.png)
---

### Documentation :


**HTTP Routes**

| Method | Path | Auth required | Description |
|---|---|---|---|
| GET | `/` | Yes (if `ENABLE_AUTH=true`) | Main app page |
| GET | `/login` | No | Login page |
| POST | `/login` | No | Submit credentials, sets session on match |
| GET | `/logout` | No | Destroys session |

---
**Socket.io Events**

| Event | Direction | Payload | Description |
|---|---|---|---|
| `search` | Client → Server | `{ query, source }` | Live search query (Deezer or Spotify) |
| `search:results` | Server → Client | `{ query, source, results }` | Search results for the query |
| `search:error` | Server → Client | `{ message }` | Non-fatal search issue (e.g. Spotify not configured, falls back to Deezer) |
| `queue:add` | Client → Server | `{ item \| url, source }` | Add a single track, URL (video/playlist/album), or playlist to the queue |
| `queue:add_csv` | Client → Server | `{ csvText, filename, source }` | Import tracks from a dropped/pasted CSV playlist export |
| `queue:added` | Server → Client | `{ jobId, title, artist, cover }` | A track entered the queue (pending) |
| `queue:progress` | Server → Client | `{ jobId, title, artist, cover, status, percent, type? }` | Live progress update for a job (fetching metadata, downloading %, tagging, or flagged `type: 'review'`) |
| `queue:done` | Server → Client | `{ jobId, title, artist, cover, destPath, message }` | Track finished, tagged, and moved into the library |
| `queue:skipped` | Server → Client | `{ jobId, title, artist, cover, reason }` | Track skipped (duplicate on disk, already processing, or skipped during review) |
| `queue:error` | Server → Client | `{ jobId, title, artist, cover, error }` | Track failed (bad URL, no tracks found, incomplete metadata, download failure) |
| `queue:info` | Server → Client | `{ message }` | General non-error status message (e.g. "Analyzing link...", playlist creation status) |
| `queue:pause` | Client → Server | — | Pause the queue (in-flight downloads finish, new ones wait) |
| `queue:resume` | Client → Server | — | Resume a paused queue |
| `queue:state` | Server → Client | `{ isPaused }` | Current pause state (sent on connect and on pause/resume) |
| `queue:cancel_item` | Client → Server | `{ jobId }` | Cancel one specific job (kills its process, cleans temp files) |
| `queue:cancel_all` | Client → Server | — | Stop all active/pending jobs and clear the queue |
| `queue:canceled` | Server → Client | `{ jobId }` | Confirms a specific job was canceled |
| `queue:canceled_all` | Server → Client | — | Confirms the whole queue was stopped/cleared |
| `review:submit` | Client → Server | `{ choices: { [jobId]: youtubeUrl \| 'skip' } }` | User's picks from the batch review screen for low-confidence matches |
| `batch:review_ready` | Server → Client | `{ items: [{ jobId, title, artist, cover, duration, candidates }] }` | Sent once the queue goes idle, if any tracks need manual review |
| `playlist:import_complete` | Server → Client | `{ playlistName, trackCount, tracks }` | Sent once a playlist import fully finishes, prompting the Navidrome confirmation card |
| `playlist:create_confirm` | Client → Server | `{ playlistName, tracks }` | User confirmed — create the matching playlist in Navidrome |
| `playlist:create_skip` | Client → Server | — | User dismissed the playlist creation prompt (no-op) |
---

## 📄 License

MIT — see [LICENSE](LICENSE).

Note: Navikat is intended for personal/fair use. Downloading copyrighted music without authorization may violate YouTube's Terms of Service and copyright law in your jurisdiction — use responsibly.