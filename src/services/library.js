const path = require('path');
const fs = require('fs');
const sanitize = require('sanitize-filename');

function cleanComponent(name, fallback = 'Unknown') {
  if (!name) return fallback;
  const cleaned = sanitize(name.trim()).trim();
  return cleaned || fallback;
}

// Navidrome library structure: /music/{AlbumArtist}/{Album} ({Year})/{TrackNumber:02d} - {Title}.mp3
function buildDestinationPath(libraryRoot, canonicalTrack) {
  const root = libraryRoot || process.env.MUSIC_LIBRARY_PATH || '/music';
  
  const albumArtist = cleanComponent(canonicalTrack.albumArtist || canonicalTrack.artist, 'Unknown Artist');
  const album = cleanComponent(canonicalTrack.album, 'Unknown Album');
  const year = canonicalTrack.year ? String(canonicalTrack.year).trim() : '';

  const albumDirName = year ? `${album} (${year})` : album;
  const trackNum = String(canonicalTrack.trackNumber || 1).padStart(2, '0');
  const title = cleanComponent(canonicalTrack.title, 'Unknown Title');
  const fileName = `${trackNum} - ${title}.mp3`;

  return path.join(root, albumArtist, albumDirName, fileName);
}

function checkDuplicate(destPath) {
  return fs.existsSync(destPath);
}

function moveToLibrary(tempFilePath, destPath) {
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  try {
    fs.renameSync(tempFilePath, destPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(tempFilePath, destPath);
      fs.unlinkSync(tempFilePath);
    } else {
      throw err;
    }
  }
  return destPath;
}

module.exports = {
  cleanComponent,
  buildDestinationPath,
  checkDuplicate,
  moveToLibrary
};
