const axios = require('axios');
const stringSimilarity = require('string-similarity');
const canonical = require('./canonical');

let accessToken = null;
let tokenExpiresAt = 0;
const artistGenreCache = new Map();

async function getAccessToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;
  if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;

  try {
    const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await axios.post(
      'https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 8000
      }
    );

    if (res.data && res.data.access_token) {
      accessToken = res.data.access_token;
      tokenExpiresAt = Date.now() + (res.data.expires_in * 1000);
      return accessToken;
    }
    return null;
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.error('[Spotify] Auth error:', err.message);
    }
    return null;
  }
}

async function getArtistGenre(artistId, token) {
  if (!artistId || !token) return null;
  if (artistGenreCache.has(artistId)) return artistGenreCache.get(artistId);

  try {
    const res = await axios.get(`https://api.spotify.com/v1/artists/${artistId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 5000
    });
    if (res.data && Array.isArray(res.data.genres) && res.data.genres.length > 0) {
      const genre = res.data.genres[0];
      artistGenreCache.set(artistId, genre);
      return genre;
    }
  } catch (e) {}
  return null;
}

async function searchTracks(query, limit = 25) {
  const token = await getAccessToken();
  if (!token || !query || !query.trim()) return [];

  try {
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`;
    const res = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 8000
    });
    if (res.data && res.data.tracks && Array.isArray(res.data.tracks.items)) {
      return res.data.tracks.items.map(track => canonical.fromSpotifyTrack(track));
    }
    return [];
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.error('[Spotify] Search error:', err.message);
    }
    return [];
  }
}

async function getTrack(trackId) {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const url = `https://api.spotify.com/v1/tracks/${trackId}`;
    const res = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 8000
    });
    if (res.data) {
      const canonicalTrack = canonical.fromSpotifyTrack(res.data);
      if (res.data.artists && res.data.artists.length > 0 && res.data.artists[0].id) {
        canonicalTrack.genre = await getArtistGenre(res.data.artists[0].id, token);
      }
      return canonicalTrack;
    }
    return null;
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.error('[Spotify] Get track error:', err.message);
    }
    return null;
  }
}

async function getPlaylistTracks(playlistId) {
  const token = await getAccessToken();
  if (!token) return { playlistName: '', tracks: [] };

  try {
    let playlistName = 'Spotify Playlist';
    try {
      const playlistMeta = await axios.get(`https://api.spotify.com/v1/playlists/${playlistId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 8000
      });
      if (playlistMeta.data && playlistMeta.data.name) playlistName = playlistMeta.data.name;
    } catch (e) {}

    const url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
    const res = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 10000
    });
    if (res.data && Array.isArray(res.data.items)) {
      const tracks = res.data.items
        .filter(item => item && item.track)
        .map(item => canonical.fromSpotifyTrack(item.track));
      return { playlistName, tracks };
    }
    return { playlistName: '', tracks: [] };
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.error('[Spotify] Get playlist error:', err.message);
    }
    return { playlistName: '', tracks: [] };
  }
}

async function getAlbumTracks(albumId) {
  const token = await getAccessToken();
  if (!token) return [];

  try {
    const albumRes = await axios.get(`https://api.spotify.com/v1/albums/${albumId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 8000
    });
    const albumData = albumRes.data;
    if (albumData && albumData.tracks && Array.isArray(albumData.tracks.items)) {
      let albumGenre = null;
      if (albumData.artists && albumData.artists.length > 0 && albumData.artists[0].id) {
        albumGenre = await getArtistGenre(albumData.artists[0].id, token);
      }

      return albumData.tracks.items.map(track => {
        const item = canonical.fromSpotifyTrack({
          ...track,
          album: {
            name: albumData.name,
            images: albumData.images,
            release_date: albumData.release_date,
            album_type: albumData.album_type,
            total_tracks: albumData.total_tracks,
            label: albumData.label,
            artists: albumData.artists
          }
        });
        if (albumGenre) item.genre = albumGenre;
        return item;
      });
    }
    return [];
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.error('[Spotify] Get album error:', err.message);
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
  const token = await getAccessToken();
  if (!token || !isrc || !isrc.trim()) return null;
  try {
    const cleanIsrc = isrc.trim().toUpperCase();
    const url = `https://api.spotify.com/v1/search?q=isrc:${encodeURIComponent(cleanIsrc)}&type=track&limit=1`;
    const res = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 8000
    });
    if (res.data && res.data.tracks && Array.isArray(res.data.tracks.items) && res.data.tracks.items.length > 0) {
      return canonical.fromSpotifyTrack(res.data.tracks.items[0]);
    }
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.warn('[Spotify] ISRC search warning:', err.message);
    }
  }
  return null;
}

module.exports = {
  isConfigured: () => Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
  searchTracks,
  getTrack,
  getPlaylistTracks,
  getAlbumTracks,
  matchByTitle,
  searchByISRC
};
