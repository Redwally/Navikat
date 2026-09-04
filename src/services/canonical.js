function cleanYouTubeTitle(rawTitle) {
  if (!rawTitle) return '';
  return rawTitle
    .replace(/[\(\[\{]\s*(official\s*(music\s*)?video|official\s*audio|lyric\s*video|audio|video|clip\s*officiel|hd|4k|mv|vizuel)\s*[\)\]\}]/gi, '')
    .replace(/\b(official\s*(music\s*)?video|official\s*audio|lyric\s*video|clip\s*officiel|hd|4k|mv)\b/gi, '')
    .replace(/\s*-\s*topic\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseYouTubeTitle(rawTitle) {
  const cleaned = cleanYouTubeTitle(rawTitle);

  const dashMatch = cleaned.match(/^(.+?)\s*[-:]\s*(.+)$/);
  if (dashMatch) {
    let artist = dashMatch[1].trim();
    let title = dashMatch[2].replace(/^["']|["']$/g, '').trim();
    title = title.replace(/\b(ft\.|feat\.)\s+[^\(\)]+/gi, '').trim();

    return { artist, title };
  }

  return {
    artist: 'Unknown Artist',
    title: cleaned || 'Unknown Title'
  };
}

function fromDeezerTrack(track) {
  if (!track) return null;

  const title = (track.title || '').trim();
  
  let artist = '';
  if (track.contributors && Array.isArray(track.contributors) && track.contributors.length > 0) {
    artist = track.contributors.map(c => c.name).filter(Boolean).join(' / ');
  }
  if (!artist) {
    artist = track.artist ? track.artist.name : 'Unknown Artist';
  }

  let albumArtist = track.album && track.album.artist ? track.album.artist.name : (track.artist ? track.artist.name : '');
  
  const album = track.album ? track.album.title : 'Unknown Album';
  const trackNumber = track.track_position || 1;
  const trackTotal = track.album ? (track.album.nb_tracks || null) : null;
  const discNumber = track.disk_number || 1;
  const discTotal = null;

  const rawReleaseDate = track.release_date || (track.album ? track.album.release_date : '') || '';
  let releaseDate = rawReleaseDate;
  if (releaseDate && releaseDate.length === 4) {
    releaseDate = `${releaseDate}-01-01`;
  }
  const year = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : null;

  let genre = null;
  if (track.genre) {
    genre = track.genre;
  } else if (track.album && track.album.genres && track.album.genres.data && track.album.genres.data.length > 0) {
    genre = track.album.genres.data[0].name;
  }

  let composer = null;
  if (track.contributors && Array.isArray(track.contributors)) {
    const composers = track.contributors.filter(c => c.role === 'Composer').map(c => c.name);
    if (composers.length > 0) composer = composers.join(' / ');
  }

  // Compilation rule: compilations must use 'Various Artists' as album-artist
  const isCompilation = track.album ? (track.album.record_type === 'compile') : false;
  if (isCompilation) {
    albumArtist = 'Various Artists';
  } else if (!albumArtist) {
    albumArtist = artist || 'Unknown Artist';
  }

  const rawAlbum = track.album || {};
  let coverUrl = rawAlbum.cover_xl || rawAlbum.cover_big || rawAlbum.cover_medium || rawAlbum.cover_small || rawAlbum.cover || '';
  if (!coverUrl && track.md5_image) {
    coverUrl = `https://e-cdns-images.dzcdn.net/images/cover/${track.md5_image}/250x250-000000-80-0-0.jpg`;
  }
  if (!coverUrl && track.artist && track.artist.picture_medium) {
    coverUrl = track.artist.picture_medium;
  }

  if (process.env.DEBUG === 'true') {
    console.log(`[Debug Canonical Deezer] "${title}" by "${artist}" => coverUrl=${coverUrl}`);
  }

  const duration = track.duration || 0;

  return {
    title,
    artist,
    albumArtist,
    album,
    trackNumber,
    trackTotal,
    discNumber,
    discTotal,
    releaseDate: releaseDate || (year ? `${year}-01-01` : ''),
    year: year || null,
    genre: genre || null,
    composer: composer || null,
    isrc: track.isrc || null,
    label: (track.album && track.album.label) || null,
    compilation: Boolean(isCompilation),
    coverUrl,
    duration,
    source: 'deezer',
    sourceId: String(track.id)
  };
}

function fromSpotifyTrack(track) {
  if (!track) return null;

  const title = (track.name || '').trim();

  const artist = track.artists && Array.isArray(track.artists)
    ? track.artists.map(a => a.name).filter(Boolean).join(' / ')
    : 'Unknown Artist';

  let albumArtist = track.album && track.album.artists && track.album.artists.length > 0
    ? track.album.artists[0].name
    : (track.artists && track.artists.length > 0 ? track.artists[0].name : '');

  const album = track.album ? track.album.name : 'Unknown Album';
  const trackNumber = track.track_number || 1;
  const trackTotal = track.album ? (track.album.total_tracks || null) : null;
  const discNumber = track.disc_number || 1;
  const discTotal = null;

  let rawReleaseDate = track.album ? (track.album.release_date || '') : '';
  if (rawReleaseDate && rawReleaseDate.length === 4) {
    rawReleaseDate = `${rawReleaseDate}-01-01`;
  }
  const year = rawReleaseDate ? parseInt(rawReleaseDate.slice(0, 4), 10) : null;

  // Compilation rule: compilations must use 'Various Artists' as album-artist
  const isCompilation = track.album ? (track.album.album_type === 'compilation') : false;
  if (isCompilation) {
    albumArtist = 'Various Artists';
  } else if (!albumArtist) {
    albumArtist = artist || 'Unknown Artist';
  }

  const albumImages = track.album && track.album.images ? track.album.images : [];
  let coverUrl = '';
  for (const img of albumImages) {
    if (img && img.url) {
      coverUrl = img.url;
      break;
    }
  }

  if (process.env.DEBUG === 'true') {
    console.log(`[Debug Canonical Spotify] "${title}" by "${artist}" => coverUrl=${coverUrl}`);
  }

  const duration = track.duration_ms
    ? Math.round(track.duration_ms / 1000)
    : (track.duration || 0);

  const isrc = track.external_ids ? (track.external_ids.isrc || null) : null;
  const label = track.album ? (track.album.label || null) : null;

  return {
    title,
    artist,
    albumArtist,
    album,
    trackNumber,
    trackTotal,
    discNumber,
    discTotal,
    releaseDate: rawReleaseDate || (year ? `${year}-01-01` : ''),
    year: year || null,
    genre: null,
    composer: null,
    isrc,
    label,
    compilation: Boolean(isCompilation),
    coverUrl,
    duration,
    source: 'spotify',
    sourceId: String(track.id)
  };
}

function fromYouTubeRaw({ title: rawTitle, url, duration, coverUrl, thumbnail, artist, title }) {
  const parsed = parseYouTubeTitle(rawTitle);
  const currentYear = new Date().getFullYear();

  let resolvedCover = coverUrl || thumbnail || '';
  if (!resolvedCover && url) {
    const match = url.match(/(?:v=|\/vi\/|\/v\/|youtu\.be\/|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (match) {
      resolvedCover = `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`;
    }
  }

  const finalTitle = title || parsed.title;
  const finalArtist = artist || parsed.artist;

  return {
    title: finalTitle,
    artist: finalArtist,
    albumArtist: finalArtist,
    album: 'YouTube Imports',
    trackNumber: 1,
    trackTotal: null,
    discNumber: 1,
    discTotal: null,
    releaseDate: `${currentYear}-01-01`,
    year: currentYear,
    genre: null,
    composer: null,
    isrc: null,
    label: null,
    compilation: false,
    coverUrl: resolvedCover,
    duration: duration || 0,
    source: 'youtube-matched',
    sourceId: url || ''
  };
}

function validateCanonicalTrack(trackObj) {
  const errors = [];
  const warnings = [];

  if (!trackObj.title || !trackObj.title.trim()) errors.push('Titre manquant');
  if (!trackObj.artist || !trackObj.artist.trim()) errors.push('Artiste manquant');
  if (!trackObj.albumArtist || !trackObj.albumArtist.trim()) errors.push('Artiste d\'album manquant');
  if (!trackObj.album || !trackObj.album.trim()) errors.push('Album manquant');
  if (!trackObj.coverUrl) warnings.push('Pochette manquante');

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

module.exports = {
  cleanYouTubeTitle,
  parseYouTubeTitle,
  fromDeezerTrack,
  fromSpotifyTrack,
  fromYouTubeRaw,
  validateCanonicalTrack
};
