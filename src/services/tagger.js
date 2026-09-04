const NodeID3 = require('node-id3');
const axios = require('axios');
const fs = require('fs');

function cleanTextString(str) {
  if (!str) return '';
  return str.replace(/^[\uFEFF\uFFFE]+/, '').trim();
}

async function fetchCoverBuffer(coverUrl) {
  if (!coverUrl) return null;
  try {
    const res = await axios.get(coverUrl, {
      responseType: 'arraybuffer',
      timeout: 8000
    });
    return Buffer.from(res.data);
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.warn('[Tagger] Cover download warning:', err.message);
    }
    return null;
  }
}

// Parse LRC timestamp [mm:ss.xx] lines into SYLT absolute millisecond entries
function parseLrcToSyncedText(lrcText) {
  if (!lrcText) return [];
  return lrcText.trim().split('\n').flatMap(line => {
    const m = line.match(/^\[(\d+):(\d{2})(?:\.(\d{2,3}))?\]\s*(.*)/);
    if (!m) return [];
    const min = +m[1], sec = +m[2];
    const ms = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
    const timeStamp = Math.round((min * 60 + sec) * 1000 + ms);
    const text = cleanTextString(m[4]) || '♪';
    return [{ text, timeStamp }];
  });
}

async function embedMetadata(mp3FilePath, canonicalTrack, lyricsObj = null) {
  let imageBuffer = null;
  if (canonicalTrack.coverUrl) {
    imageBuffer = await fetchCoverBuffer(canonicalTrack.coverUrl);
  }

  let lyricsText = '';
  if (lyricsObj) {
    if (lyricsObj.syncedLyrics) {
      lyricsText = cleanTextString(lyricsObj.syncedLyrics);
    } else if (lyricsObj.plainLyrics) {
      lyricsText = cleanTextString(lyricsObj.plainLyrics);
    }
  }

  const trackNumStr = String(canonicalTrack.trackNumber || 1);
  const trckValue = canonicalTrack.trackTotal
    ? `${trackNumStr}/${canonicalTrack.trackTotal}`
    : trackNumStr;

  const discNumStr = String(canonicalTrack.discNumber || 1);
  const tposValue = canonicalTrack.discTotal
    ? `${discNumStr}/${canonicalTrack.discTotal}`
    : discNumStr;

  const yearStr = canonicalTrack.year ? String(canonicalTrack.year) : '';
  const dateStr = canonicalTrack.releaseDate || yearStr;

  const tags = {
    title: cleanTextString(canonicalTrack.title),
    artist: cleanTextString(canonicalTrack.artist),
    album: cleanTextString(canonicalTrack.album),
    performerInfo: cleanTextString(canonicalTrack.albumArtist || canonicalTrack.artist),
    trackNumber: trckValue,
    partOfSet: tposValue,
    year: yearStr,
    date: dateStr,
    recordingTime: yearStr
  };

  if (canonicalTrack.genre) tags.genre = cleanTextString(canonicalTrack.genre);
  if (canonicalTrack.composer) tags.composer = cleanTextString(canonicalTrack.composer);
  if (canonicalTrack.isrc) tags.isrc = cleanTextString(canonicalTrack.isrc);
  if (canonicalTrack.label) tags.publisher = cleanTextString(canonicalTrack.label);

  tags.userDefinedText = [
    { description: 'TCMP', value: canonicalTrack.compilation ? '1' : '0' }
  ];

  tags.comment = {
    language: 'eng',
    text: `Downloaded via Navikat from ${canonicalTrack.source || 'unknown'}:${canonicalTrack.sourceId || ''}`
  };

  if (imageBuffer) {
    tags.image = {
      mime: 'image/jpeg',
      type: { id: 3, name: 'front cover' },
      description: 'Cover',
      imageBuffer: imageBuffer
    };
  }

  // USLT: raw LRC text with lang=XXX and shortText=Lyrics for players supporting synced lyrics in USLT
  if (lyricsText) {
    tags.unsynchronisedLyrics = {
      language: 'XXX',
      shortText: 'Lyrics',
      text: lyricsText
    };
  }

  // SYLT: binary millisecond-timestamped frame (timeStampFormat: 2 = absolute milliseconds, contentType: 1 = lyrics)
  let syltCount = 0;
  if (lyricsObj && lyricsObj.syncedLyrics) {
    const syncedTextArray = parseLrcToSyncedText(lyricsObj.syncedLyrics);
    if (syncedTextArray.length > 0) {
      syltCount = syncedTextArray.length;
      tags.synchronisedLyrics = [{
        language: 'eng',
        timeStampFormat: 2,
        contentType: 1,
        shortText: 'Lyrics',
        synchronisedText: syncedTextArray
      }];
    }
  }

  if (process.env.DEBUG === 'true') {
    console.log(`[Debug Tagger] "${canonicalTrack.artist} - ${canonicalTrack.title}" (year: ${yearStr}, USLT: ${lyricsText.length} chars, SYLT: ${syltCount} lines)`);
  }

  const success = NodeID3.write(tags, mp3FilePath);

  if (process.env.DEBUG === 'true') {
    try {
      const buf = fs.readFileSync(mp3FilePath);
      const hasSylt = buf.indexOf('SYLT') !== -1;
      const hasUslt = buf.indexOf('USLT') !== -1;
      console.log(`  [Debug Frame Verify] USLT: ${hasUslt}, SYLT: ${hasSylt}`);
    } catch (_) {}
  }

  return { success, syltCount };
}

module.exports = {
  cleanTextString,
  parseLrcToSyncedText,
  embedMetadata
};
