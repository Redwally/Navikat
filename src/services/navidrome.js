const axios = require('axios');
const crypto = require('crypto');

function generateSubsonicAuth(password) {
  const salt = crypto.randomBytes(8).toString('hex');
  const token = crypto.createHash('md5').update(password + salt).digest('hex');
  return { token, salt };
}

async function triggerScan() {
  const baseUrl = process.env.NAVIDROME_URL;
  const user = process.env.NAVIDROME_USER;
  const password = process.env.NAVIDROME_PASSWORD;

  if (!baseUrl || !user || !password) {
    return { skipped: true, reason: 'Navidrome credentials not configured' };
  }

  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
  const { token, salt } = generateSubsonicAuth(password);

  try {
    const subsonicUrl = `${cleanBaseUrl}/rest/startScan.view`;
    const res = await axios.get(subsonicUrl, {
      params: {
        u: user,
        t: token,
        s: salt,
        v: '1.16.1',
        c: 'navikat',
        f: 'json'
      },
      timeout: 8000
    });

    if (process.env.DEBUG === 'true') {
      console.log('[Navidrome] Scan triggered successfully:', res.data);
    }
    return { success: true, data: res.data };
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.warn('[Navidrome] Subsonic scan error, attempting native fallback:', err.message);
    }

    try {
      const nativeUrl = `${cleanBaseUrl}/api/library/scan`;
      const res = await axios.post(nativeUrl, {}, { timeout: 8000 });
      return { success: true, data: res.data };
    } catch (fallbackErr) {
      if (process.env.DEBUG === 'true') {
        console.error('[Navidrome] Scan fallback error:', fallbackErr.message);
      }
      return { success: false, error: err.message };
    }
  }
}

async function findSongId(artist, title, cleanBaseUrl, user, token, salt) {
  try {
    const query = `${artist || ''} ${title}`.trim();
    const searchUrl = `${cleanBaseUrl}/rest/search3.view`;
    const res = await axios.get(searchUrl, {
      params: {
        u: user,
        t: token,
        s: salt,
        v: '1.16.1',
        c: 'navikat',
        f: 'json',
        query
      },
      timeout: 6000
    });

    const songResult = res.data && res.data['subsonic-response'] && res.data['subsonic-response'].searchResult3 && res.data['subsonic-response'].searchResult3.song;
    if (Array.isArray(songResult) && songResult.length > 0) {
      return songResult[0].id;
    }
  } catch (e) {
    if (process.env.DEBUG === 'true') {
      console.warn(`[Navidrome] Song search warning for "${artist} - ${title}":`, e.message);
    }
  }
  return null;
}

async function createPlaylist(playlistName, trackList) {
  const baseUrl = process.env.NAVIDROME_URL;
  const user = process.env.NAVIDROME_USER;
  const password = process.env.NAVIDROME_PASSWORD;

  if (!baseUrl || !user || !password || !playlistName || !trackList || !trackList.length) {
    return { skipped: true, reason: 'Missing credentials or playlist data' };
  }

  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
  const { token, salt } = generateSubsonicAuth(password);

  const songIds = [];
  for (const track of trackList) {
    const songId = await findSongId(track.artist, track.title, cleanBaseUrl, user, token, salt);
    if (songId) songIds.push(songId);
  }

  if (!songIds.length) {
    if (process.env.DEBUG === 'true') {
      console.warn(`[Navidrome] Could not resolve any song IDs in Navidrome for playlist "${playlistName}".`);
    }
    return { success: false, reason: 'No song IDs resolved' };
  }

  try {
    const createUrl = `${cleanBaseUrl}/rest/createPlaylist.view`;
    const params = new URLSearchParams();
    params.append('u', user);
    params.append('t', token);
    params.append('s', salt);
    params.append('v', '1.16.1');
    params.append('c', 'navikat');
    params.append('f', 'json');
    params.append('name', playlistName);
    for (const id of songIds) {
      params.append('songId', id);
    }

    const res = await axios.get(`${createUrl}?${params.toString()}`, { timeout: 8000 });
    if (process.env.DEBUG === 'true') {
      console.log(`[Navidrome] Playlist "${playlistName}" created with ${songIds.length} tracks.`);
    }
    return { success: true, count: songIds.length, data: res.data };
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.error(`[Navidrome] Create playlist error for "${playlistName}":`, err.message);
    }
    return { success: false, error: err.message };
  }
}

module.exports = {
  triggerScan,
  createPlaylist
};
