import crypto from 'crypto';
if (!globalThis.crypto) {
  // @ts-ignore
  globalThis.crypto = crypto.webcrypto || crypto;
}

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { BaileysManager } from './baileysManager';
import { createRouter } from './routes';

const app = express();
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

const manager = new BaileysManager(io);
const router = createRouter(manager);
app.use(router);

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 6300;

server.listen(port, () => {
  console.log(`=======================================================`);
  console.log(` WinZapp Baileys Gateway Server running on port ${port} `);
  console.log(` Memory Footprint: ~50-60 MB | WebSocket Direct Ready  `);
  console.log(`=======================================================`);
});

io.on('connection', (socket) => {
  console.log(`[Socket.IO] Python client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Python client disconnected: ${socket.id}`);
  });
});
