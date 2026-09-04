const { spawn, exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs');

const execAsync = util.promisify(exec);

function spawnYtDlp(argsArray, onProgress, options = {}) {
  return new Promise((resolve, reject) => {
    const extractorArgs = ['--extractor-args', 'youtube:player_client=ios,mweb,web,android', '--newline'];
    const fullArgs = [...extractorArgs, ...argsArray];

    let stdoutData = '';
    let stderrData = '';

    const parseProgress = (str) => {
      if (!onProgress) return;
      const matches = str.match(/\[download\]\s+(\d+(?:\.\d+)?)\%/g);
      if (matches && matches.length > 0) {
        const last = matches[matches.length - 1];
        const m = last.match(/(\d+(?:\.\d+)?)\%/);
        if (m) {
          const pct = parseFloat(m[1]);
          onProgress(pct);
        }
      }
    };

    let child = spawn('yt-dlp', fullArgs);
    if (options.onSpawn) options.onSpawn(child);

    child.stdout.on('data', (data) => {
      const str = data.toString();
      stdoutData += str;
      parseProgress(str);
    });

    child.stderr.on('data', (d) => {
      stderrData += d.toString();
    });

    child.on('error', () => {
      const pyChild = spawn('python', ['-m', 'yt_dlp', ...fullArgs]);
      if (options.onSpawn) options.onSpawn(pyChild);

      let pyStdout = '';
      let pyStderr = '';

      pyChild.stdout.on('data', (data) => {
        const str = data.toString();
        pyStdout += str;
        parseProgress(str);
      });

      pyChild.stderr.on('data', (d) => {
        pyStderr += d.toString();
      });

      pyChild.on('close', (code, signal) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          return reject(new Error('ABORTED'));
        }
        if (code === 0) resolve({ stdout: pyStdout, stderr: pyStderr });
        else reject(new Error(`yt-dlp exited with code ${code}: ${pyStderr}`));
      });
    });

    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        return reject(new Error('ABORTED'));
      }
      if (code === 0) resolve({ stdout: stdoutData, stderr: stderrData });
      else reject(new Error(`yt-dlp exited with code ${code}: ${stderrData}`));
    });
  });
}

function cleanYouTubeTitle(rawTitle) {
  if (!rawTitle) return '';
  return rawTitle
    .replace(/[\(\[\{]\s*(official\s*(music\s*)?video|official\s*audio|lyric\s*video|audio|video|clip\s*officiel|hd|4k|mv|vizuel)\s*[\)\]\}]/gi, '')
    .replace(/\b(official\s*(music\s*)?video|official\s*audio|lyric\s*video|clip\s*officiel|hd|4k|mv)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseYouTubeTitle(rawTitle) {
  const cleaned = cleanYouTubeTitle(rawTitle);

  const dashMatch = cleaned.match(/^(.+?)\s*[-:]\s*(.+)$/);
  if (dashMatch) {
    return {
      artist: dashMatch[1].trim(),
      title: dashMatch[2].replace(/^["']|["']$/g, '').trim()
    };
  }

  return {
    artist: 'Unknown Artist',
    title: cleaned
  };
}

async function convertToMp3Cbr(inputPath, outputPath) {
  const cmd = `ffmpeg -y -i "${inputPath}" -vn -c:a libmp3lame -b:a 320k "${outputPath}"`;
  await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
}

async function searchYouTubeCandidates(artist, title) {
  const searchString = `${artist} - ${title}`;
  const searchArgs = [`ytsearch5:${searchString}`, '--dump-json', '--no-playlist'];

  const candidates = [];
  try {
    const { stdout } = await spawnYtDlp(searchArgs);
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item && (item.webpage_url || item.url)) {
          candidates.push({
            url: item.webpage_url || item.url,
            title: item.title || '',
            channel: item.uploader || item.channel || item.uploader_id || 'YouTube',
            duration: item.duration || 0,
            thumbnail: item.thumbnail || (item.thumbnails && item.thumbnails.length > 0 ? item.thumbnails[0].url : '')
          });
        }
      } catch (e) {}
    }
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.error('[yt-dlp] Search candidates error:', err.message);
    }
  }

  return candidates;
}

async function searchAndDownload(artist, title, expectedDurationSec, finalTempMp3Path, onProgress, options = {}) {
  const candidates = await searchYouTubeCandidates(artist, title);

  if (candidates.length === 0) {
    throw new Error(`No YouTube source found for "${artist} - ${title}"`);
  }

  if (expectedDurationSec && expectedDurationSec > 0) {
    const bestDiff = Math.abs(candidates[0].duration - expectedDurationSec);
    if (options.requireConfidence && bestDiff > 15) {
      const err = new Error('CONFIDENCE_THRESHOLD_FAILED');
      err.candidates = candidates;
      throw err;
    }
    
    candidates.sort((a, b) => {
      const diffA = Math.abs(a.duration - expectedDurationSec);
      const diffB = Math.abs(b.duration - expectedDurationSec);
      return diffA - diffB;
    });
  }

  const rawTempPath = finalTempMp3Path + '.raw.tmp';
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const downloadArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', rawTempPath, candidate.url];
      await spawnYtDlp(downloadArgs, onProgress, options);

      let downloadedFile = rawTempPath;
      if (!fs.existsSync(downloadedFile)) {
        const dir = path.dirname(rawTempPath);
        const base = path.basename(rawTempPath);
        const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
        if (files.length > 0) {
          downloadedFile = path.join(dir, files[0]);
        }
      }

      if (!fs.existsSync(downloadedFile)) {
        throw new Error('Downloaded raw audio file not found');
      }

      await convertToMp3Cbr(downloadedFile, finalTempMp3Path);

      if (fs.existsSync(downloadedFile)) {
        fs.unlinkSync(downloadedFile);
      }

      return {
        matchedUrl: candidate.url,
        matchedTitle: candidate.title,
        matchedDuration: candidate.duration
      };
    } catch (err) {
      if (err.message === 'ABORTED') throw err;
      if (process.env.DEBUG === 'true') {
        console.warn(`[yt-dlp] Failed candidate ${candidate.url}:`, err.message);
      }
      lastError = err;
      if (fs.existsSync(rawTempPath)) {
        try { fs.unlinkSync(rawTempPath); } catch (e) {}
      }
    }
  }

  throw lastError || new Error('Failed to download audio from YouTube candidates');
}

async function downloadDirectUrl(videoUrl, finalTempMp3Path, onProgress, options = {}) {
  const rawTempPath = finalTempMp3Path + '.raw.tmp';

  const infoArgs = ['--dump-json', '--no-playlist', videoUrl];
  let videoInfo = { title: '', duration: 0 };
  try {
    const { stdout } = await spawnYtDlp(infoArgs, null, options);
    const parsed = JSON.parse(stdout);
    videoInfo.title = parsed.title || '';
    videoInfo.duration = parsed.duration || 0;
  } catch (e) {
    if (e.message === 'ABORTED') throw e;
    if (process.env.DEBUG === 'true') {
      console.warn('[yt-dlp] Direct URL info fetch warning:', e.message);
    }
  }

  const downloadArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', rawTempPath, videoUrl];
  await spawnYtDlp(downloadArgs, onProgress, options);

  let downloadedFile = rawTempPath;
  if (!fs.existsSync(downloadedFile)) {
    const dir = path.dirname(rawTempPath);
    const base = path.basename(rawTempPath);
    const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
    if (files.length > 0) {
      downloadedFile = path.join(dir, files[0]);
    }
  }

  if (!fs.existsSync(downloadedFile)) {
    throw new Error('Direct YouTube audio download failed');
  }

  await convertToMp3Cbr(downloadedFile, finalTempMp3Path);

  if (fs.existsSync(downloadedFile)) {
    fs.unlinkSync(downloadedFile);
  }

  return videoInfo;
}

async function getVideoInfo(videoUrl) {
  try {
    const { stdout } = await spawnYtDlp(['--dump-json', '--no-playlist', videoUrl]);
    const info = JSON.parse(stdout.trim());
    return {
      title: info.title || '',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || getYouTubeThumbnail(videoUrl)
    };
  } catch (e) {
    if (process.env.DEBUG === 'true') {
      console.warn('[yt-dlp] getVideoInfo failed:', e.message);
    }
    return { title: '', duration: 0, thumbnail: getYouTubeThumbnail(videoUrl) };
  }
}

function getYouTubeThumbnail(videoIdOrUrl) {
  if (!videoIdOrUrl) return '';
  let id = videoIdOrUrl;
  const match = videoIdOrUrl.match(/(?:v=|\/vi\/|\/v\/|youtu\.be\/|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (match) id = match[1];
  if (id && id.length === 11) {
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  }
  return '';
}

async function getPlaylistVideos(playlistUrl) {
  const playlistArgs = ['--flat-playlist', '--dump-json', playlistUrl];
  const { stdout } = await spawnYtDlp(playlistArgs);

  const items = [];
  let playlistName = 'YouTube Playlist';
  const lines = stdout.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.playlist_title) {
        playlistName = parsed.playlist_title;
      }
      if (parsed && (parsed.url || parsed.id)) {
        const videoId = parsed.id || '';
        const videoUrl = parsed.url || `https://www.youtube.com/watch?v=${videoId}`;
        const thumbnail = (parsed.thumbnails && parsed.thumbnails.length > 0 ? parsed.thumbnails[parsed.thumbnails.length - 1].url : null) || parsed.thumbnail || getYouTubeThumbnail(videoId || videoUrl);
        const parsedInfo = parseYouTubeTitle(parsed.title || '');

        items.push({
          type: 'youtube_video',
          url: videoUrl,
          rawTitle: parsed.title || '',
          title: parsedInfo.title,
          artist: parsedInfo.artist,
          coverUrl: thumbnail,
          cover: thumbnail,
          duration: parsed.duration || 0
        });
      }
    } catch (e) {}
  }
  return { playlistName, tracks: items };
}

module.exports = {
  cleanYouTubeTitle,
  parseYouTubeTitle,
  getYouTubeThumbnail,
  getVideoInfo,
  searchYouTubeCandidates,
  searchAndDownload,
  downloadDirectUrl,
  getPlaylistVideos
};
