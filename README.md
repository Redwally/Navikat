# Navikat

Navikat is a self-hosted web application that fetches music tracks and playlists from Deezer, Spotify, YouTube, and CSV exports, downloads high-quality 320kbps audio, and embeds complete metadata, HD covers, and synchronized lyrics directly into your Navidrome music library. It automatically handles file naming, organization, deduplication, and triggers a Navidrome library scan once downloads finish.

---

## 🚀 Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/redwally/navikat.git
   cd navikat
   ```

2. **Configure environment:**
   Copy `.env.example` to `.env`. Add your [Spotify Developer API keys](https://developer.spotify.com/dashboard) if you want Spotify search enabled, and set `ENABLE_AUTH=true` with a secure `AUTH_PASSWORD` if you want password protection.
   ```bash
   cp .env.example .env
   ```

3. **Configure your music volume:**
   In `docker-compose.yml`, edit the `volumes:` line to point to your real music directory on the host (the left side before the colon is your host folder path, while the right side `/music` is the container path and must not be changed).
   ```yaml
   volumes:
     - /path/to/your/actual/music/folder:/music
   ```

4. **Start the container:**
   ```bash
   docker compose up -d --build
   ```

5. **Open Navikat:**
   Navigate to [http://localhost:3000](http://localhost:3000) in your web browser.

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
![Main Screen](screenshots/01_main_screen.png)

### Download Queue Panel
![Queue Panel](screenshots/02_queue_panel.png)

### Unmatched Tracks Review Modal
![Batch Review](screenshots/03_batch_review.png)

### Minimalist Login
![Login Screen](screenshots/04_login.png)

