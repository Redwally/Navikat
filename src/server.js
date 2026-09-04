require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const routes = require('./routes');
const { registerSearchHandlers } = require('./sockets/search');
const { registerQueueHandlers } = require('./sockets/queue');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'navikat-secret-session-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.use((socket, next) => {
  if (process.env.ENABLE_AUTH === 'true') {
    const session = socket.request.session;
    if (!session || !session.authenticated) {
      return next(new Error('Unauthorized socket connection'));
    }
  }
  next();
});

app.use('/', routes);

io.on('connection', (socket) => {
  if (process.env.DEBUG === 'true') {
    console.log(`[Socket] Client connected: ${socket.id}`);
  }

  registerSearchHandlers(io, socket);
  registerQueueHandlers(io, socket);

  socket.on('disconnect', () => {
    if (process.env.DEBUG === 'true') {
      console.log(`[Socket] Client disconnected: ${socket.id}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Navikat running on http://localhost:${PORT} (Music: ${process.env.MUSIC_LIBRARY_PATH || '/music'}, Auth: ${process.env.ENABLE_AUTH === 'true'})`);
  if (process.env.DEBUG === 'true') {
    const authPwd = process.env.AUTH_PASSWORD;
    const sessionSecret = process.env.SESSION_SECRET;
    console.log(`[DEBUG] ENABLE_AUTH=${process.env.ENABLE_AUTH}`);
    console.log(`[DEBUG] AUTH_PASSWORD: ${authPwd ? `set (${authPwd.length} chars)` : 'NOT SET / EMPTY'}`);
    console.log(`[DEBUG] SESSION_SECRET: ${sessionSecret ? `set (${sessionSecret.length} chars)` : 'NOT SET / EMPTY'}`);
  }
});
