"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = __importDefault(require("crypto"));
if (!globalThis.crypto) {
    // @ts-ignore
    globalThis.crypto = crypto_1.default.webcrypto || crypto_1.default;
}
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const baileysManager_1 = require("./baileysManager");
const routes_1 = require("./routes");
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '100mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '100mb' }));
const manager = new baileysManager_1.BaileysManager(io);
const router = (0, routes_1.createRouter)(manager);
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
    manager.onClientConnected(socket);
    socket.on('disconnect', () => {
        console.log(`[Socket.IO] Python client disconnected: ${socket.id}`);
    });
});
