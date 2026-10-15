'use strict';

const WebSocket = require('ws');
const { WORDS } = require('./words');

const PORT = Number(process.env.PORT) || 3001;

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateName() {
  const count = 3 + Math.floor(Math.random() * 3);
  return shuffle(WORDS)
    .slice(0, count)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const server = new WebSocket.Server({ port: PORT });

// ws -> { id, name, publicKey }
const clients = new Map();

function broadcast(json, exceptWs) {
  const payload = JSON.stringify(json);
  server.clients.forEach((client) => {
    if (client !== exceptWs && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function relay(toId, json, exceptWs) {
  for (const [ws, c] of clients) {
    if (c.id === toId && ws !== exceptWs && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(json));
      return true;
    }
  }
  return false;
}

function userList() {
  return Array.from(clients.values()).map((c) => ({
    id: c.id,
    name: c.name,
    publicKey: c.publicKey,
  }));
}

server.on('connection', (ws) => {
  const id = crypto.randomUUID();
  let name = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        name = generateName();
        clients.set(ws, {
          id,
          name,
          publicKey: msg.publicKey || null,
        });
        // Direct message to the joining client — marks it as their own identity
        ws.send(JSON.stringify({ type: 'joined', id, name, self: true }));
        // Broadcast to everyone else — presence announcement
        broadcast({ type: 'joined', id, name, publicKey: msg.publicKey || null }, ws);
        broadcast({ type: 'users', users: userList() });
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        // Relay WebRTC signaling metadata only — never message content
        relay(msg.to, { type: msg.type, from: id, ...msg.payload }, ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (name) {
      clients.delete(ws);
      broadcast({ type: 'left', id, name });
      broadcast({ type: 'users', users: userList() });
    }
  });
});

console.log(`Signaling server listening on ws://localhost:${PORT}`);
