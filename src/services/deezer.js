const axios = require('axios');
const stringSimilarity = require('string-similarity');
const canonical = require('./canonical');

const DEEZER_API_BASE = 'https://api.deezer.com';
const genreCache = new Map();

async function getGenreName(genreId) {
  if (!genreId) return null;
  if (genreCache.has(genreId)) return genreCache.get(genreId);

  try {
    const res = await axios.get(`${DEEZER_API_BASE}/genre/${genreId}`, { timeout: 5000 });
    if (res.data && res.data.name) {
      genreCache.set(genreId, res.data.name);
      return res.data.name;
    }
  } catch (e) {}
  return null;
}

async function searchTracks(query, limit = 25) {
  if (!query || !query.trim()) return [];
  try {
    const url = `${DEEZER_API_BASE}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 8000 });
    if (res.data && Array.isArray(res.data.data)) {
      return res.data.data.map(track => canonical.fromDeezerTrack(track));
    }
    return [];
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.error('[Deezer] Search error:', err.message);
    }
    return [];
  }
}

async function getTrack(trackId) {
  try {
    const url = `${DEEZER_API_BASE}/track/${trackId}`;
    const res = await axios.get(url, { timeout: 8000 });
    if (res.data && !res.data.error) {
      const canonicalTrack = canonical.fromDeezerTrack(res.data);
      if (res.data.album && res.data.album.genre_id) {
        canonicalTrack.genre = await getGenreName(res.data.album.genre_id);
      }
      return canonicalTrack;
    }
    return null;
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.error('[Deezer] Get track error:', err.message);
    }
    return null;
  }
}

async function getPlaylistTracks(playlistId) {
  try {
    const url = `${DEEZER_API_BASE}/playlist/${playlistId}`;
    const res = await axios.get(url, { timeout: 10000 });
    if (res.data && res.data.tracks && Array.isArray(res.data.tracks.data)) {
      const playlistCover = res.data.picture_xl || res.data.picture_big;
      const playlistTitle = res.data.title || 'Deezer Playlist';
      const tracks = res.data.tracks.data.map(track => {
        const item = canonical.fromDeezerTrack(track);
        if (!item.coverUrl) item.coverUrl = playlistCover;
        return item;
      });
      return { playlistName: playlistTitle, tracks };
    }
    return { playlistName: '', tracks: [] };
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.error('[Deezer] Get playlist error:', err.message);
    }
    return { playlistName: '', tracks: [] };
  }
}

async function getAlbumTracks(albumId) {
  try {
    const url = `${DEEZER_API_BASE}/album/${albumId}`;
    const res = await axios.get(url, { timeout: 10000 });
    if (res.data && res.data.tracks && Array.isArray(res.data.tracks.data)) {
      const albumMeta = res.data;
      let albumGenre = null;
      if (albumMeta.genre_id) {
        albumGenre = await getGenreName(albumMeta.genre_id);
      } else if (albumMeta.genres && albumMeta.genres.data && albumMeta.genres.data.length > 0) {
        albumGenre = albumMeta.genres.data[0].name;
      }

      return albumMeta.tracks.data.map(track => {
        const item = canonical.fromDeezerTrack({
          ...track,
          album: {
            title: albumMeta.title,
            cover_xl: albumMeta.cover_xl,
            cover_big: albumMeta.cover_big,
            cover_medium: albumMeta.cover_medium,
            release_date: albumMeta.release_date,
            artist: albumMeta.artist,
            nb_tracks: albumMeta.nb_tracks,
            record_type: albumMeta.record_type,
            label: albumMeta.label
          },
          artist: track.artist || albumMeta.artist
        });
        if (albumGenre) item.genre = albumGenre;
        return item;
      });
    }
    return [];
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.error('[Deezer] Get album error:', err.message);
    }
    return [];
  }
}

async function matchByTitle(artist, title) {
  const query = [artist, title].filter(Boolean).join(' ');
  if (!query) return null;

  const tracks = await searchTracks(query, 10);
  if (!tracks.length) return null;

  const targetStr = `${artist || ''} - ${title}`.toLowerCase().trim();
  let bestMatch = null;
  let highestScore = 0;

  for (const track of tracks) {
    const candidateStr = `${track.artist} - ${track.title}`.toLowerCase().trim();
    const score = stringSimilarity.compareTwoStrings(targetStr, candidateStr);
    if (score > highestScore) {
      highestScore = score;
      bestMatch = track;
    }
  }

  return highestScore >= 0.25 ? bestMatch : tracks[0];
}

async function searchByISRC(isrc) {
  if (!isrc || !isrc.trim()) return null;
  try {
    const cleanIsrc = isrc.trim().toUpperCase();
    const url = `${DEEZER_API_BASE}/track/isrc:${encodeURIComponent(cleanIsrc)}`;
    const res = await axios.get(url, { timeout: 8000 });
    if (res.data && !res.data.error && res.data.id) {
      return canonical.fromDeezerTrack(res.data);
    }
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.warn('[Deezer] ISRC search warning:', err.message);
    }
  }
  return null;
}

module.exports = {
  searchTracks,
  getTrack,
  getPlaylistTracks,
  getAlbumTracks,
  matchByTitle,
  searchByISRC
};
