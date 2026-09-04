const pLimit = require('p-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const canonical = require('../services/canonical');
const deezer = require('../services/deezer');
const spotify = require('../services/spotify');
const ytdlp = require('../services/ytdlp');
const lyrics = require('../services/lyrics');
const tagger = require('../services/tagger');
const library = require('../services/library');
const navidrome = require('../services/navidrome');

const maxConcurrency = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3', 10);
const limit = pLimit(maxConcurrency);

const activeQueueKeys = new Set();
const activeProcesses = new Map();
const pendingReviews = new Map();
const canceledJobIds = new Set();
let isQueueCanceledAll = false;
let isQueuePaused = false;
let pendingCount = 0;
let scanTimeout = null;

let activePlaylistName = null;
const completedPlaylistTracks = [];

const tmpDir = path.resolve(__dirname, '../../tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

function sweepTmpDirectory(targetJobId = null) {
  if (!fs.existsSync(tmpDir)) return;

  try {
    const files = fs.readdirSync(tmpDir);
    const staleFiles = [];

    for (const file of files) {
      const isNavikatTemp = file.startsWith('navikat_') || file.includes('.raw.tmp') || file.endsWith('.tmp');
      if (!isNavikatTemp) continue;

      if (targetJobId) {
        if (file.includes(targetJobId)) {
          staleFiles.push(file);
        }
      } else {
        staleFiles.push(file);
      }
    }

    if (staleFiles.length > 0) {
      for (const file of staleFiles) {
        const fullPath = path.join(tmpDir, file);
        try {
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
        } catch (e) {}
      }
    }
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.warn('[Queue Cleanup Warning] Failed to scan tmp/ directory:', err.message);
    }
  }
}

function getItemKey(item) {
  if (item.source && item.sourceId) return `${item.source}:${item.sourceId}`.toLowerCase();
  if (item.url) return item.url.trim().toLowerCase();
  const artist = (item.artist || '').trim().toLowerCase();
  const title = (item.title || '').trim().toLowerCase();
  return `${artist}::${title}`;
}

async function parseUrlInput(urlInput, preferredSource = 'deezer') {
  const url = urlInput.trim();
  const items = [];
  let playlistName = null;

  if (url.includes('youtube.com/watch') || url.includes('youtu.be/')) {
    const info = await ytdlp.getVideoInfo(url);
    items.push({
      type: 'youtube_video',
      url,
      rawTitle: info.title,
      duration: info.duration,
      coverUrl: info.thumbnail
    });
    return { playlistName: null, items };
  }

  if (url.includes('youtube.com/playlist') || url.includes('youtu.be/playlist')) {
    const res = await ytdlp.getPlaylistVideos(url);
    playlistName = res.playlistName || 'YouTube Playlist';
    for (const v of (res.tracks || [])) {
      items.push({
        type: 'youtube_video',
        url: v.url,
        rawTitle: v.title,
        duration: v.duration
      });
    }
    return { playlistName, items };
  }

  if (url.includes('deezer.com')) {
    const trackMatch = url.match(/\/track\/(\d+)/);
    if (trackMatch) {
      const track = await deezer.getTrack(trackMatch[1]);
      if (track) items.push(track);
      return { playlistName: null, items };
    }

    const playlistMatch = url.match(/\/playlist\/(\d+)/);
    if (playlistMatch) {
      const res = await deezer.getPlaylistTracks(playlistMatch[1]);
      return { playlistName: res.playlistName || 'Deezer Playlist', items: res.tracks || [] };
    }

    const albumMatch = url.match(/\/album\/(\d+)/);
    if (albumMatch) {
      const tracks = await deezer.getAlbumTracks(albumMatch[1]);
      return { playlistName: null, items: tracks || [] };
    }
  }

  if (url.includes('spotify.com')) {
    const trackMatch = url.match(/\/track\/([a-zA-Z0-9]+)/);
    if (trackMatch) {
      const track = await spotify.getTrack(trackMatch[1]);
      if (track) items.push(track);
      return { playlistName: null, items };
    }

    const playlistMatch = url.match(/\/playlist\/([a-zA-Z0-9]+)/);
    if (playlistMatch) {
      const res = await spotify.getPlaylistTracks(playlistMatch[1]);
      return { playlistName: res.playlistName || 'Spotify Playlist', items: res.tracks || [] };
    }

    const albumMatch = url.match(/\/album\/([a-zA-Z0-9]+)/);
    if (albumMatch) {
      const tracks = await spotify.getAlbumTracks(albumMatch[1]);
      return { playlistName: null, items: tracks || [] };
    }
  }

  const fallback = preferredSource === 'spotify' && spotify.isConfigured()
    ? await spotify.matchByTitle('', url)
    : await deezer.matchByTitle('', url);

  if (fallback) items.push(fallback);
  return { playlistName: null, items };
}

function parseCSV(csvText) {
  if (!csvText) return [];
  const lines = [];
  let currentField = '';
  let inQuotes = false;
  let currentLine = [];

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((char === ',' || char === ';') && !inQuotes) {
      currentLine.push(currentField.trim());
      currentField = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      currentLine.push(currentField.trim());
      if (currentLine.some(f => f.length > 0)) {
        lines.push(currentLine);
      }
      currentLine = [];
      currentField = '';
    } else {
      currentField += char;
    }
  }
  if (currentField || currentLine.length > 0) {
    currentLine.push(currentField.trim());
    if (currentLine.some(f => f.length > 0)) {
      lines.push(currentLine);
    }
  }

  if (lines.length === 0) return [];

  const headers = lines[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i];
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }

  return rows;
}

function extractRowData(row) {
  const keys = Object.keys(row);
  const findVal = (...patterns) => {
    for (const pat of patterns) {
      for (const k of keys) {
        if (k.includes(pat)) return row[k];
      }
    }
    return '';
  };

  const title = findVal('trackname', 'title', 'name', 'track', 'song');
  const artist = findVal('artistname', 'artist', 'artistnames', 'artists');
  const album = findVal('albumname', 'album', 'albumtitle');
  const playlistName = findVal('playlistname', 'playlist', 'playlisttitle');
  const isrc = findVal('isrc');

  let deezerId = findVal('deezerid', 'deezer');
  if (deezerId && deezerId.includes('/track/')) {
    const m = deezerId.match(/\/track\/(\d+)/);
    if (m) deezerId = m[1];
  }

  let spotifyId = findVal('spotifyid', 'spotifyuri', 'spotify');
  if (spotifyId) {
    if (spotifyId.startsWith('spotify:track:')) {
      spotifyId = spotifyId.replace('spotify:track:', '');
    } else if (spotifyId.includes('/track/')) {
      const m = spotifyId.match(/\/track\/([a-zA-Z0-9]+)/);
      if (m) spotifyId = m[1];
    }
  }

  return {
    title: title.trim(),
    artist: artist.trim(),
    album: album.trim(),
    playlistName: playlistName ? playlistName.trim() : null,
    isrc: isrc ? isrc.trim() : null,
    deezerId: deezerId ? deezerId.trim() : null,
    spotifyId: spotifyId ? spotifyId.trim() : null
  };
}

async function resolveCsvRow(rowData, preferredSource) {
  if (rowData.deezerId) {
    try {
      const track = await deezer.getTrack(rowData.deezerId);
      if (track) return track;
    } catch (e) {}
  }

  if (rowData.spotifyId && spotify.isConfigured()) {
    try {
      const track = await spotify.getTrack(rowData.spotifyId);
      if (track) return track;
    } catch (e) {}
  }

  if (rowData.isrc) {
    if (preferredSource === 'spotify' && spotify.isConfigured()) {
      const spMatch = await spotify.searchByISRC(rowData.isrc);
      if (spMatch) return spMatch;
    }
    const dzMatch = await deezer.searchByISRC(rowData.isrc);
    if (dzMatch) return dzMatch;
  }

  if (rowData.artist || rowData.title) {
    const match = preferredSource === 'spotify' && spotify.isConfigured()
      ? await spotify.matchByTitle(rowData.artist, rowData.title)
      : await deezer.matchByTitle(rowData.artist, rowData.title);
    if (match) return match;
  }

  if (rowData.title) {
    return {
      title: rowData.title,
      artist: rowData.artist || 'Unknown Artist',
      albumArtist: rowData.artist || 'Unknown Artist',
      album: rowData.album || 'CSV Import',
      trackNumber: 1,
      trackTotal: null,
      discNumber: 1,
      discTotal: null,
      releaseDate: '',
      year: null,
      genre: null,
      composer: null,
      isrc: rowData.isrc || null,
      label: null,
      compilation: false,
      coverUrl: '',
      duration: 0,
      source: 'csv-row',
      sourceId: ''
    };
  }

  return null;
}

async function processTrackItem(item, io) {
  const jobId = item.jobId || crypto.randomUUID();
  let canonicalTrack = null;

  if (item.type === 'youtube_video') {
    const defaultCover = item.coverUrl || item.cover || (item.url ? ytdlp.getYouTubeThumbnail(item.url) : '');
    const rawTitle = item.rawTitle || item.title || '';
    const parsedInfo = canonical.parseYouTubeTitle(rawTitle);

    // Use the parsed artist only if it was actually split from the title (not a generic fallback).
    // When no "Artist - Title" separator is found, parsedInfo.artist is 'Unknown Artist' — don't
    // pass that into the metadata search; search by cleaned full title instead.
    const hasRealArtist = item.artist || (parsedInfo.artist && parsedInfo.artist !== 'Unknown Artist');
    const searchArtist = hasRealArtist ? (item.artist || parsedInfo.artist) : '';
    const searchTitle = hasRealArtist ? parsedInfo.title : (canonical.cleanYouTubeTitle(rawTitle) || rawTitle);

    const displayTitle = hasRealArtist ? parsedInfo.title : (canonical.cleanYouTubeTitle(rawTitle) || rawTitle || item.url);
    const displayArtist = hasRealArtist ? (item.artist || parsedInfo.artist) : (canonical.cleanYouTubeTitle(rawTitle) || rawTitle || 'Unknown');

    io.emit('queue:progress', {
      jobId,
      title: displayTitle,
      artist: displayArtist,
      cover: defaultCover,
      status: 'Fetching metadata...',
      percent: 5
    });

    const preferredSource = item.preferredSource || 'deezer';
    const match = preferredSource === 'spotify' && spotify.isConfigured()
      ? await spotify.matchByTitle(searchArtist, searchTitle)
      : await deezer.matchByTitle(searchArtist, searchTitle);

    if (match) {
      canonicalTrack = {
        ...match,
        directUrl: item.url,
        coverUrl: match.coverUrl || defaultCover
      };
    } else {
      // No Deezer/Spotify match — build a canonical track from the YouTube title itself.
      canonicalTrack = canonical.fromYouTubeRaw({
        rawTitle,
        url: item.url,
        duration: item.duration || 0,
        coverUrl: defaultCover
      });
      canonicalTrack.directUrl = item.url;
    }
  } else {
    canonicalTrack = item;
  }

  if (!canonicalTrack.year && canonicalTrack.sourceId) {
    try {
      let enriched = null;
      if (canonicalTrack.source === 'deezer') {
        enriched = await deezer.getTrack(canonicalTrack.sourceId);
      } else if (canonicalTrack.source === 'spotify') {
        enriched = await spotify.getTrack(canonicalTrack.sourceId);
      }
      if (enriched) {
        canonicalTrack = { ...canonicalTrack, ...enriched };
      }
    } catch (e) {
      if (process.env.DEBUG === 'true') {
        console.warn('[Queue] Metadata enrichment warning:', e.message);
      }
    }
  }

  const validation = canonical.validateCanonicalTrack(canonicalTrack);
  if (!validation.valid) {
    const errorMsg = `Incomplete metadata: ${validation.errors.join(', ')}`;
    io.emit('queue:error', {
      jobId,
      title: canonicalTrack.title || 'Unknown',
      artist: canonicalTrack.artist || 'Unknown',
      cover: canonicalTrack.coverUrl || '',
      error: errorMsg
    });
    return;
  }

  const title = canonicalTrack.title;
  const artist = canonicalTrack.artist;
  const itemKey = getItemKey(canonicalTrack);

  const libraryRoot = process.env.MUSIC_LIBRARY_PATH || '/music';
  const destPath = library.buildDestinationPath(libraryRoot, canonicalTrack);

  if (library.checkDuplicate(destPath)) {
    activeQueueKeys.delete(itemKey);
    io.emit('queue:skipped', {
      jobId,
      title,
      artist,
      cover: canonicalTrack.coverUrl || '',
      reason: 'Already in music library'
    });
    return;
  }

  const tempMp3Filename = `navikat_${jobId}_${Date.now()}.mp3`;
  const tempMp3Path = path.join(tmpDir, tempMp3Filename);

  try {
    io.emit('queue:progress', {
      jobId,
      title,
      artist,
      cover: canonicalTrack.coverUrl || '',
      status: 'Downloading audio (0%)...',
      percent: 10
    });

    const onDownloadProgress = (dlPercent) => {
      const overallPercent = Math.round(10 + (dlPercent * 0.7));
      io.emit('queue:progress', {
        jobId,
        title,
        artist,
        cover: canonicalTrack.coverUrl || '',
        status: `Downloading audio (${Math.round(dlPercent)}%)...`,
        percent: overallPercent
      });
    };

    const downloadOptions = {
      requireConfidence: Boolean(item.isBatchImport),
      onSpawn: (childProc) => {
        activeProcesses.set(jobId, { child: childProc, tempMp3Path });
      }
    };

    if (canonicalTrack.directUrl) {
      await ytdlp.downloadDirectUrl(canonicalTrack.directUrl, tempMp3Path, onDownloadProgress, downloadOptions);
    } else {
      await ytdlp.searchAndDownload(artist, title, canonicalTrack.duration, tempMp3Path, onDownloadProgress, downloadOptions);
    }

    activeProcesses.delete(jobId);

    io.emit('queue:progress', {
      jobId,
      title,
      artist,
      cover: canonicalTrack.coverUrl || '',
      status: 'Fetching lyrics...',
      percent: 85
    });

    const lyricsObj = await lyrics.fetchLyrics({
      artist,
      title,
      album: canonicalTrack.album,
      duration: canonicalTrack.duration
    });

    io.emit('queue:progress', {
      jobId,
      title,
      artist,
      cover: canonicalTrack.coverUrl || '',
      status: 'Embedding tags and cover image...',
      percent: 95
    });

    await tagger.embedMetadata(tempMp3Path, canonicalTrack, lyricsObj);
    library.moveToLibrary(tempMp3Path, destPath);

    activeQueueKeys.delete(itemKey);
    completedPlaylistTracks.push({ artist, title });

    io.emit('queue:done', {
      jobId,
      title,
      artist,
      cover: canonicalTrack.coverUrl || '',
      destPath,
      message: 'Completed! Track added to library.'
    });
  } catch (err) {
    activeProcesses.delete(jobId);

    if (err.message === 'ABORTED') {
      activeQueueKeys.delete(itemKey);
      if (fs.existsSync(tempMp3Path)) {
        try { fs.unlinkSync(tempMp3Path); } catch (e) { }
      }
      io.emit('queue:canceled', { jobId });
      return;
    }

    if (err.message === 'CONFIDENCE_THRESHOLD_FAILED') {
      activeQueueKeys.delete(itemKey);
      pendingReviews.set(jobId, {
        jobId,
        canonicalTrack,
        candidates: err.candidates || []
      });
      io.emit('queue:progress', {
        jobId,
        title,
        artist,
        cover: canonicalTrack.coverUrl || '',
        status: 'Needs manual review',
        percent: 100,
        type: 'review'
      });
      return;
    }

    if (process.env.DEBUG === 'true') {
      console.error(`[Queue Worker Error] ${artist} - ${title}:`, err.message);
    }
    activeQueueKeys.delete(itemKey);
    if (fs.existsSync(tempMp3Path)) {
      try { fs.unlinkSync(tempMp3Path); } catch (e) { }
    }
    io.emit('queue:error', {
      jobId,
      title,
      artist,
      cover: canonicalTrack.coverUrl || '',
      error: `Download failed: ${err.message}`
    });
  }
}

function registerQueueHandlers(io, socket) {
  socket.emit('queue:state', { isPaused: isQueuePaused });

  socket.on('queue:pause', () => {
    isQueuePaused = true;
    io.emit('queue:state', { isPaused: true });
  });

  socket.on('queue:resume', () => {
    isQueuePaused = false;
    io.emit('queue:state', { isPaused: false });
  });

  socket.on('queue:cancel_item', (data) => {
    const { jobId } = data || {};
    if (!jobId) return;

    canceledJobIds.add(jobId);

    if (activeProcesses.has(jobId)) {
      const procInfo = activeProcesses.get(jobId);
      if (procInfo && procInfo.child) {
        try {
          procInfo.child.kill('SIGTERM');
          const childRef = procInfo.child;
          setTimeout(() => {
            try {
              if (childRef && !childRef.killed) {
                childRef.kill('SIGKILL');
              }
            } catch (e) { }
            sweepTmpDirectory(jobId);
          }, 1500);
        } catch (e) { }
      }
      if (procInfo && procInfo.tempMp3Path) {
        try {
          if (fs.existsSync(procInfo.tempMp3Path)) fs.unlinkSync(procInfo.tempMp3Path);
          const rawTmp = procInfo.tempMp3Path + '.raw.tmp';
          if (fs.existsSync(rawTmp)) fs.unlinkSync(rawTmp);
        } catch (e) { }
      }
      activeProcesses.delete(jobId);
    }
    sweepTmpDirectory(jobId);
    io.emit('queue:canceled', { jobId });
  });

  socket.on('queue:cancel_all', () => {
    isQueueCanceledAll = true;
    if (limit.clearQueue) {
      try { limit.clearQueue(); } catch (e) {}
    }
    for (const [jobId, procInfo] of activeProcesses.entries()) {
      if (procInfo && procInfo.child) {
        try {
          procInfo.child.kill('SIGTERM');
          const childRef = procInfo.child;
          setTimeout(() => {
            try {
              if (childRef && !childRef.killed) {
                childRef.kill('SIGKILL');
              }
            } catch (e) { }
            sweepTmpDirectory();
          }, 1500);
        } catch (e) { }
      }
      if (procInfo && procInfo.tempMp3Path) {
        try {
          if (fs.existsSync(procInfo.tempMp3Path)) fs.unlinkSync(procInfo.tempMp3Path);
          const rawTmp = procInfo.tempMp3Path + '.raw.tmp';
          if (fs.existsSync(rawTmp)) fs.unlinkSync(rawTmp);
        } catch (e) { }
      }
    }
    activeProcesses.clear();
    activeQueueKeys.clear();
    pendingReviews.clear();
    canceledJobIds.clear();
    completedPlaylistTracks.length = 0;
    activePlaylistName = null;
    pendingCount = 0;
    sweepTmpDirectory();
    io.emit('queue:canceled_all');
  });

  socket.on('review:submit', async (data) => {
    const { choices = {} } = data || {};
    for (const [jobId, choice] of Object.entries(choices)) {
      const reviewItem = pendingReviews.get(jobId);
      pendingReviews.delete(jobId);

      if (!reviewItem || choice === 'skip') {
        io.emit('queue:skipped', {
          jobId,
          title: reviewItem ? reviewItem.canonicalTrack.title : 'Track',
          artist: reviewItem ? reviewItem.canonicalTrack.artist : 'Artist',
          cover: reviewItem ? reviewItem.canonicalTrack.coverUrl : '',
          reason: 'Skipped during manual review'
        });
        continue;
      }

      const trackWithUrl = {
        ...reviewItem.canonicalTrack,
        directUrl: choice,
        jobId
      };

      pendingCount++;
      activeQueueKeys.add(getItemKey(trackWithUrl));

      limit(async () => {
        if (isQueueCanceledAll || canceledJobIds.has(jobId)) {
          canceledJobIds.delete(jobId);
          pendingCount--;
          checkQueueIdle();
          return;
        }

        try {
          await processTrackItem(trackWithUrl, io);
        } finally {
          pendingCount--;
          checkQueueIdle();
        }
      });
    }
  });

  socket.on('queue:add', async (data) => {
    const { item, url, source = 'deezer' } = data || {};
    isQueueCanceledAll = false;

    let targetItems = [];
    let playlistName = null;

    if (url) {
      try {
        socket.emit('queue:info', { message: 'Analyzing link...' });
        const parsed = await parseUrlInput(url, source);
        targetItems = parsed.items || [];
        playlistName = parsed.playlistName || null;
      } catch (err) {
        socket.emit('queue:error', {
          title: 'Invalid URL',
          error: `Unable to parse link: ${err.message}`
        });
        return;
      }
    } else if (item) {
      targetItems = [item];
    }

    if (!targetItems.length) {
      socket.emit('queue:error', {
        title: 'No Tracks',
        error: 'No tracks found to add to download queue.'
      });
      return;
    }

    if (playlistName) {
      activePlaylistName = playlistName;
    }

    const isBatchImport = targetItems.length > 1;

    for (const trackItem of targetItems) {
      const jobId = crypto.randomUUID();
      const trackKey = getItemKey(trackItem);

      const parsedYT = trackItem.type === 'youtube_video' ? canonical.parseYouTubeTitle(trackItem.rawTitle || trackItem.title || '') : null;
      const displayTitle = trackItem.title || (parsedYT ? parsedYT.title : trackItem.rawTitle || 'Track');
      const displayArtist = trackItem.artist || (parsedYT ? parsedYT.artist : 'Artist');
      const displayCover = trackItem.coverUrl || trackItem.cover || (trackItem.url ? ytdlp.getYouTubeThumbnail(trackItem.url) : '');

      if (activeQueueKeys.has(trackKey)) {
        socket.emit('queue:skipped', {
          jobId,
          title: displayTitle,
          artist: displayArtist,
          cover: displayCover,
          reason: 'Already processing'
        });
        continue;
      }

      activeQueueKeys.add(trackKey);
      pendingCount++;

      io.emit('queue:added', {
        jobId,
        title: displayTitle,
        artist: displayArtist,
        cover: displayCover
      });

      limit(async () => {
        if (isQueueCanceledAll || canceledJobIds.has(jobId)) {
          canceledJobIds.delete(jobId);
          pendingCount--;
          checkQueueIdle();
          return;
        }

        while (isQueuePaused) {
          if (isQueueCanceledAll || canceledJobIds.has(jobId)) {
            canceledJobIds.delete(jobId);
            pendingCount--;
            checkQueueIdle();
            return;
          }
          await new Promise(r => setTimeout(r, 500));
        }

        try {
          await processTrackItem({
            ...trackItem,
            jobId,
            preferredSource: source,
            isBatchImport
          }, io);
        } finally {
          pendingCount--;
          checkQueueIdle();
        }
      });
    }
  });

  socket.on('queue:add_csv', async (data) => {
    const { csvText, filename, source = 'deezer' } = data || {};
    isQueueCanceledAll = false;

    if (!csvText || typeof csvText !== 'string' || !csvText.trim()) {
      socket.emit('queue:error', { title: 'Invalid CSV', error: 'Empty or unreadable CSV file.' });
      return;
    }

    try {
      socket.emit('queue:info', { message: `Parsing CSV file "${filename || 'import.csv'}"...` });
      const rawRows = parseCSV(csvText);

      if (!rawRows.length) {
        socket.emit('queue:error', { title: 'Invalid CSV', error: 'No data rows found in CSV.' });
        return;
      }

      let detectedPlaylistName = null;
      const targetItems = [];

      for (const row of rawRows) {
        const rowData = extractRowData(row);
        if (!rowData.title && !rowData.deezerId && !rowData.spotifyId && !rowData.isrc) continue;

        if (rowData.playlistName && !detectedPlaylistName) {
          detectedPlaylistName = rowData.playlistName;
        }

        const resolvedTrack = await resolveCsvRow(rowData, source);
        if (resolvedTrack) {
          targetItems.push(resolvedTrack);
        }
      }

      if (!targetItems.length) {
        socket.emit('queue:error', { title: 'No Match', error: 'No valid tracks could be resolved from CSV.' });
        return;
      }

      if (detectedPlaylistName) {
        activePlaylistName = detectedPlaylistName;
      } else if (filename) {
        activePlaylistName = filename.replace(/\.csv$/i, '');
      }

      const isBatchImport = targetItems.length > 1;

      for (const trackItem of targetItems) {
        const jobId = crypto.randomUUID();
        const trackKey = getItemKey(trackItem);

        if (activeQueueKeys.has(trackKey)) {
          socket.emit('queue:skipped', {
            jobId,
            title: trackItem.title || 'Track',
            artist: trackItem.artist || 'Artist',
            cover: trackItem.coverUrl || trackItem.cover || '',
            reason: 'Already processing'
          });
          continue;
        }

        activeQueueKeys.add(trackKey);
        pendingCount++;

        io.emit('queue:added', {
          jobId,
          title: trackItem.title || 'Track',
          artist: trackItem.artist || 'Artist',
          cover: trackItem.coverUrl || trackItem.cover || ''
        });

        limit(async () => {
          if (isQueueCanceledAll || canceledJobIds.has(jobId)) {
            canceledJobIds.delete(jobId);
            pendingCount--;
            checkQueueIdle();
            return;
          }

          while (isQueuePaused) {
            if (isQueueCanceledAll || canceledJobIds.has(jobId)) {
              canceledJobIds.delete(jobId);
              pendingCount--;
              checkQueueIdle();
              return;
            }
            await new Promise(r => setTimeout(r, 500));
          }

          try {
            await processTrackItem({
              ...trackItem,
              jobId,
              preferredSource: source,
              isBatchImport
            }, io);
          } finally {
            pendingCount--;
            checkQueueIdle();
          }
        });
      }
    } catch (err) {
      if (process.env.DEBUG === 'true') {
        console.error('[CSV Import Error]', err);
      }
      socket.emit('queue:error', { title: 'CSV Import Failed', error: err.message });
    }
  });

  socket.on('playlist:create_confirm', async (data) => {
    const { playlistName, tracks } = data || {};
    if (!playlistName || !tracks || !tracks.length) return;

    io.emit('queue:info', { message: `Creating Navidrome playlist "${playlistName}"...` });
    const plRes = await navidrome.createPlaylist(playlistName, tracks);
    if (plRes.success) {
      io.emit('queue:info', { message: `Navidrome playlist "${playlistName}" created successfully!` });
    } else {
      io.emit('queue:error', { title: 'Playlist Creation Failed', error: plRes.error || 'Failed to create playlist in Navidrome.' });
    }
  });

  socket.on('playlist:create_skip', () => {});

  function checkQueueIdle() {
    if (pendingCount === 0) {
      sweepTmpDirectory();
      if (pendingReviews.size > 0) {
        const reviewList = [];
        for (const [jobId, rev] of pendingReviews.entries()) {
          reviewList.push({
            jobId,
            title: rev.canonicalTrack.title,
            artist: rev.canonicalTrack.artist,
            cover: rev.canonicalTrack.coverUrl,
            duration: rev.canonicalTrack.duration,
            candidates: rev.candidates
          });
        }
        io.emit('batch:review_ready', { items: reviewList });
      }

      if (scanTimeout) clearTimeout(scanTimeout);
      scanTimeout = setTimeout(async () => {
        if (process.env.DEBUG === 'true') {
          console.log('[Queue] Queue idle, triggering Navidrome scan...');
        }
        await navidrome.triggerScan();

        if (activePlaylistName && completedPlaylistTracks.length > 0) {
          const playlistToCreate = activePlaylistName;
          const tracksToInclude = [...completedPlaylistTracks];
          activePlaylistName = null;
          completedPlaylistTracks.length = 0;

          io.emit('playlist:import_complete', {
            playlistName: playlistToCreate,
            trackCount: tracksToInclude.length,
            tracks: tracksToInclude
          });
        }
      }, 5000);
    }
  }
}

module.exports = {
  registerQueueHandlers
};
