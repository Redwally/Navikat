const axios = require('axios');

const LRCLIB_BASE = 'https://lrclib.net/api';

async function fetchLyrics({ artist, title, album, duration }) {
  if (!title) return null;

  try {
    const params = {
      track_name: title,
      artist_name: artist || ''
    };
    if (album) params.album_name = album;
    if (duration) params.duration = Math.round(duration);

    try {
      const res = await axios.get(`${LRCLIB_BASE}/get`, {
        params,
        timeout: 6000
      });
      if (res.data && (res.data.syncedLyrics || res.data.plainLyrics)) {
        if (process.env.DEBUG === 'true') {
          console.log(`[Debug Lyrics Exact Match] "${artist} - ${title}"`);
        }
        return {
          syncedLyrics: res.data.syncedLyrics || null,
          plainLyrics: res.data.plainLyrics || null
        };
      }
    } catch (e) {}

    const searchRes = await axios.get(`${LRCLIB_BASE}/search`, {
      params: { q: `${artist || ''} ${title}`.trim() },
      timeout: 6000
    });

    if (searchRes.data && Array.isArray(searchRes.data) && searchRes.data.length > 0) {
      const best = searchRes.data[0];
      if (best.syncedLyrics || best.plainLyrics) {
        if (process.env.DEBUG === 'true') {
          console.log(`[Debug Lyrics Search Match] "${artist} - ${title}"`);
        }
        return {
          syncedLyrics: best.syncedLyrics || null,
          plainLyrics: best.plainLyrics || null
        };
      }
    }

    return null;
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.warn('[LRCLIB] Lyrics search warning:', err.message);
    }
    return null;
  }
}

module.exports = {
  fetchLyrics
};
