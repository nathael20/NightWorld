#!/usr/bin/env node
/**
 * NightWorld Server — Pure Node.js, ZERO dépendances
 * Usage: node server.js [port]
 * Port par défaut: 8080
 */

const http = require('http');
const crypto = require('crypto');
const os = require('os');

const PORT = parseInt(process.argv[2]) || 8080;

// ── State ──
const clients = new Map(); // socket → {id, name, room, x, y, outfit}
let nextId = 1;

// ── WebSocket frame parser ──
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  let maskKey = null;
  if (masked) {
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + payloadLen) return null;

  const payload = buf.slice(offset, offset + payloadLen);
  if (masked && maskKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }

  return { opcode, payload, totalLength: offset + payloadLen };
}

function makeFrame(data) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// ── Broadcast helpers ──
function send(socket, obj) {
  try { socket.write(makeFrame(JSON.stringify(obj))); } catch (e) {}
}

function broadcast(obj, exceptSocket = null) {
  const frame = makeFrame(JSON.stringify(obj));
  for (const [sock] of clients) {
    if (sock !== exceptSocket) {
      try { sock.write(frame); } catch (e) {}
    }
  }
}

function broadcastRoom(roomId, obj, exceptSocket = null) {
  const frame = makeFrame(JSON.stringify(obj));
  for (const [sock, info] of clients) {
    if (sock !== exceptSocket && info.room === roomId) {
      try { sock.write(frame); } catch (e) {}
    }
  }
}

// ── Handle WebSocket message ──
function handleMsg(socket, data) {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch (e) { return; }

  const info = clients.get(socket);
  if (!info) return;

  switch (msg.type) {

    case 'join': {
      info.name   = (msg.name || 'Joueur').slice(0, 16);
      info.outfit = msg.outfit || {};
      info.room   = msg.room || 'nightclub';
      info.x      = msg.x ?? 7;
      info.y      = msg.y ?? 7;
      info.emote  = '';

      // Send current players list to newcomer
      const others = [];
      for (const [, p] of clients) {
        if (p.id !== info.id) {
          others.push({ id: p.id, name: p.name, outfit: p.outfit, room: p.room, x: p.x, y: p.y, emote: p.emote });
        }
      }
      send(socket, { type: 'welcome', you: info.id, players: others });

      // Announce to room
      broadcastRoom(info.room, { type: 'player_join', player: { id: info.id, name: info.name, outfit: info.outfit, room: info.room, x: info.x, y: info.y, emote: '' } }, socket);

      console.log(`[+] ${info.name} (${info.id}) → ${info.room}`);
      break;
    }

    case 'move': {
      info.x = msg.x ?? info.x;
      info.y = msg.y ?? info.y;
      broadcastRoom(info.room, { type: 'move', id: info.id, x: info.x, y: info.y }, socket);
      break;
    }

    case 'chat': {
      const text = (msg.text || '').slice(0, 120);
      broadcastRoom(info.room, { type: 'chat', id: info.id, name: info.name, text }, socket);
      // Echo back to sender too (so they see it)
      send(socket, { type: 'chat', id: info.id, name: info.name, text });
      console.log(`[chat] ${info.name}: ${text}`);
      break;
    }

    case 'emote': {
      info.emote = msg.emote || '';
      broadcastRoom(info.room, { type: 'emote', id: info.id, emote: info.emote }, socket);
      break;
    }

    case 'room_change': {
      const oldRoom = info.room;
      info.room = msg.room || 'nightclub';
      info.x = msg.x ?? 5;
      info.y = msg.y ?? 5;

      // Tell old room this player left
      broadcastRoom(oldRoom, { type: 'player_leave', id: info.id }, socket);
      // Tell new room this player arrived
      broadcastRoom(info.room, { type: 'player_join', player: { id: info.id, name: info.name, outfit: info.outfit, room: info.room, x: info.x, y: info.y, emote: '' } }, socket);
      // Tell the player who's in the new room
      const inRoom = [];
      for (const [, p] of clients) {
        if (p.id !== info.id && p.room === info.room) {
          inRoom.push({ id: p.id, name: p.name, outfit: p.outfit, room: p.room, x: p.x, y: p.y, emote: p.emote });
        }
      }
      send(socket, { type: 'room_players', players: inRoom });
      console.log(`[~] ${info.name} → ${info.room}`);
      break;
    }

    case 'outfit_update': {
      info.outfit = msg.outfit || info.outfit;
      info.name   = (msg.name || info.name).slice(0, 16);
      broadcastRoom(info.room, { type: 'outfit_update', id: info.id, outfit: info.outfit, name: info.name }, socket);
      break;
    }

    case 'apart_update': {
      // Store apart data server-side so visitors can see it
      info.apartData = msg.data;
      break;
    }

    case 'apart_visit': {
      // Another player wants to visit someone's apart
      const target = [...clients.values()].find(p => p.id === msg.targetId);
      if (target) {
        send(socket, { type: 'apart_data', ownerId: target.id, ownerName: target.name, data: target.apartData || null });
      }
      break;
    }

    case 'ping': {
      send(socket, { type: 'pong', time: msg.time });
      break;
    }
  }
}

// ── HTTP + WS Server ──
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`NightWorld Server running on port ${PORT}\nPlayers: ${clients.size}\n`);
});

server.on('upgrade', (req, socket, head) => {
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }

  // Handshake
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n' +
    'Access-Control-Allow-Origin: *\r\n\r\n'
  );

  const id = 'p' + (nextId++).toString(36) + '_' + Date.now().toString(36).slice(-4);
  clients.set(socket, { id, name: '?', room: 'nightclub', x: 7, y: 7, outfit: {}, emote: '', apartData: null });

  let buf = Buffer.alloc(0);

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const frame = parseFrame(buf);
      if (!frame) break;
      buf = buf.slice(frame.totalLength);
      if (frame.opcode === 0x8) { socket.destroy(); break; } // close
      if (frame.opcode === 0x9) { // ping → pong
        socket.write(Buffer.from([0x8a, 0x00]));
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        handleMsg(socket, frame.payload);
      }
    }
  });

  socket.on('close', () => {
    const info = clients.get(socket);
    if (info) {
      console.log(`[-] ${info.name} disconnected`);
      broadcastRoom(info.room, { type: 'player_leave', id: info.id });
      clients.delete(socket);
    }
  });

  socket.on('error', () => {
    const info = clients.get(socket);
    if (info) { broadcastRoom(info.room, { type: 'player_leave', id: info.id }); clients.delete(socket); }
  });

  // Keepalive ping every 25s
  const keepalive = setInterval(() => {
    if (socket.destroyed) { clearInterval(keepalive); return; }
    try { socket.write(Buffer.from([0x89, 0x00])); } catch (e) { clearInterval(keepalive); }
  }, 25000);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║        NIGHTWORLD SERVER  ✦          ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║  Port  : ${PORT}                          ║`);
  // Show local IPs
  const ifaces = os.networkInterfaces();
  Object.values(ifaces).forEach(list => {
    list.forEach(iface => {
      if (iface.family === 'IPv4' && !iface.internal) {
        const ip = iface.address.padEnd(16);
        console.log(`  ║  IP    : ${ip}              ║`);
      }
    });
  });
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║  Dans le jeu, connecte-toi à :       ║`);
  console.log(`  ║  ws://<ton-IP>:${PORT}                  ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nServeur arrêté.');
  process.exit(0);
});
