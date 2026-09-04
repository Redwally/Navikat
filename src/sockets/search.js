const deezer = require('../services/deezer');
const spotify = require('../services/spotify');

function registerSearchHandlers(io, socket) {
  socket.on('search', async (data) => {
    const { query, source = 'deezer' } = data || {};

    if (!query || typeof query !== 'string' || !query.trim()) {
      socket.emit('search:results', { query: '', source, results: [] });
      return;
    }

    try {
      let results = [];
      if (source === 'spotify') {
        if (spotify.isConfigured()) {
          results = await spotify.searchTracks(query);
        } else {
          socket.emit('search:error', {
            message: 'Spotify Client ID / Secret non configurés. Utilisation de Deezer.'
          });
          results = await deezer.searchTracks(query);
        }
      } else {
        results = await deezer.searchTracks(query);
      }

      socket.emit('search:results', {
        query,
        source,
        results
      });
    } catch (err) {
      if (process.env.DEBUG === 'true') {
        console.error('[Socket Search] Error:', err.message);
      }
      socket.emit('search:results', { query, source, results: [] });
    }
  });
}

module.exports = {
  registerSearchHandlers
};
