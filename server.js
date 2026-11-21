// Minimal, dependency-free HTTP lobby server for VersusNet.hxc.
// Deploy on a Node.js host. The host should provide HTTPS and set PORT.
// Requires Node.js 18+; run locally with: node server.js
"use strict";

const http = require("node:http");
const { randomBytes } = require("node:crypto");

const PORT = Number(process.env.PORT || 8080);
const rooms = new Map();
const ROOM_TTL_MS = 90_000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVENTS = 256;

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request too large"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error("invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    const bytes = randomBytes(6);
    code = Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
  } while (rooms.has(code));
  return code;
}

function token() { return randomBytes(24).toString("hex"); }
function cleanName(value) {
  const name = String(value || "Player").replace(/[<>\r\n]/g, "").trim().slice(0, 20);
  return name || "Player";
}
function getPlayer(room, value) {
  return room.players.find(p => p.token === value);
}

async function route(req, res) {
  if (req.method === "OPTIONS") return send(res, 200, { ok: true });
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/" && req.method === "GET") {
    const page = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VersusNet</title><style>body{font:16px system-ui;background:#10101c;color:#f6f4ff;max-width:720px;margin:12vh auto;padding:24px}h1{color:#80ffb1}code{background:#25253a;padding:3px 7px;border-radius:5px}a{color:#80ffb1}</style><h1>VersusNet</h1><p>Servidor de salas online para el mod 1vs1 de Friday Night Funkin'.</p><p id="state">Revisando servidor…</p><p>API de salud: <a href="/health">/health</a></p><script>fetch('/health').then(r=>r.json()).then(x=>document.querySelector('#state').textContent=x.ok?'Servidor en línea':'Servidor no disponible').catch(()=>document.querySelector('#state').textContent='No se pudo contactar al servidor');</script></html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(page) });
    return res.end(page);
  }
  if (url.pathname === "/health" && req.method === "GET") return send(res, 200, { ok: true });

  if (url.pathname === "/v1/rooms" && req.method === "POST") {
    const body = await readJson(req);
    const code = makeCode();
    const playerToken = token();
    const room = {
      code,
      players: [{ token: playerToken, name: cleanName(body.name), seen: Date.now() }],
      events: [],
      seq: 0,
      created: Date.now()
    };
    rooms.set(code, room);
    return send(res, 201, { code, token: playerToken, player: 1 });
  }

  const match = url.pathname.match(/^\/v1\/rooms\/([A-Z0-9]{4,8})\/(join|poll|events|leave)$/);
  if (!match) return send(res, 404, { error: "ruta no encontrada" });
  const code = match[1];
  const action = match[2];
  const room = rooms.get(code);
  if (!room) return send(res, 404, { error: "la sala no existe o expiró" });

  if (action === "join" && req.method === "POST") {
    if (room.players.length >= 2) return send(res, 409, { error: "la sala está llena" });
    const body = await readJson(req);
    const playerToken = token();
    room.players.push({ token: playerToken, name: cleanName(body.name), seen: Date.now() });
    return send(res, 200, { code, token: playerToken, player: 2 });
  }

  const suppliedToken = action === "poll" ? url.searchParams.get("token") : (await readJson(req)).token;
  const player = getPlayer(room, suppliedToken);
  if (!player) return send(res, 403, { error: "token de jugador inválido" });
  player.seen = Date.now();

  if (action === "poll" && req.method === "GET") {
    const since = Number(url.searchParams.get("since") || 0);
    const opponent = room.players.find(p => p !== player);
    const events = room.events.filter(e => e.seq > since && e.from !== player.token);
    return send(res, 200, {
      code,
      state: opponent ? "ready" : "waiting",
      opponent: opponent ? { name: opponent.name } : null,
      events: events.map(e => ({ seq: e.seq, kind: e.kind, payload: e.payload, at: e.at }))
    });
  }

  if (action === "events" && req.method === "POST") {
    // readJson was consumed above to extract the token; preserve the legacy shape
    // by rejecting this route here. The body is parsed once below in the handler.
    return send(res, 400, { error: "usa el formato esperado: token, kind y payload" });
  }

  if (action === "leave" && req.method === "POST") {
    room.players = room.players.filter(p => p !== player);
    if (room.players.length === 0) rooms.delete(code);
    return send(res, 200, { ok: true });
  }

  return send(res, 405, { error: "método no permitido" });
}

// Dedicated event route handler: parse its JSON body exactly once.
const originalRoute = route;
async function handler(req, res) {
  const eventMatch = new URL(req.url, "http://localhost").pathname.match(/^\/v1\/rooms\/([A-Z0-9]{4,8})\/events$/);
  if (eventMatch && req.method === "POST") {
    const room = rooms.get(eventMatch[1]);
    if (!room) return send(res, 404, { error: "la sala no existe o expiró" });
    const body = await readJson(req);
    const player = getPlayer(room, body.token);
    if (!player) return send(res, 403, { error: "token de jugador inválido" });
    if (room.players.length < 2) return send(res, 409, { error: "falta el rival" });
    const kind = String(body.kind || "").slice(0, 32);
    if (!kind) return send(res, 400, { error: "falta el tipo de evento" });
    player.seen = Date.now();
    const event = { seq: ++room.seq, from: player.token, kind, payload: body.payload ?? null, at: Date.now() };
    room.events.push(event);
    if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS);
    return send(res, 200, { ok: true, seq: event.seq });
  }
  return originalRoute(req, res);
}

const server = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch(err => {
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : "error interno" });
    else res.destroy();
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    room.players = room.players.filter(p => now - p.seen < ROOM_TTL_MS);
    if (room.players.length === 0 || now - room.created > 6 * 60 * 60 * 1000) rooms.delete(code);
  }
}, 15_000).unref();

server.listen(PORT, "0.0.0.0", () => console.log(`VersusNet lobby listening on ${PORT}`));
