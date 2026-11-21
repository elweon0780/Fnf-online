// VersusNet lobby API (Node.js 18+, no external packages).
// Render: Build command = echo "No build required"; Start command = node server.js
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const PORT = Number(process.env.PORT || 8080);
const rooms = new Map();
const ROOM_TTL_MS = 90_000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVENTS = 512;
const SONG_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

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
  do { code = Array.from(crypto.randomBytes(6), b => alphabet[b % alphabet.length]).join(""); }
  while (rooms.has(code));
  return code;
}
function makeToken() { return crypto.randomBytes(24).toString("hex"); }
function cleanName(value) {
  const name = String(value || "Player").replace(/[<>\r\n]/g, "").trim().slice(0, 20);
  return name || "Player";
}
function cleanSong(value) { const id = String(value || "").trim(); return SONG_ID.test(id) ? id.toLowerCase() : ""; }
function passwordRecord(value) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(String(value), salt, 32).toString("hex") };
}
function passwordMatches(record, value) {
  if (!record) return true;
  const candidate = crypto.scryptSync(String(value || ""), record.salt, 32);
  const expected = Buffer.from(record.hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
function findPlayer(room, token) { return room.players.find(player => player.token === token); }
function publicRoom(room) {
  return { code: room.code, host: room.players[0]?.name || "Player", players: room.players.length,
    visibility: room.visibility, song: room.song, phase: room.phase, created: room.created };
}
function pushEvent(room, player, kind, payload) {
  const event = { seq: ++room.seq, from: player?.token || "server", kind, payload, at: Date.now() };
  room.events.push(event);
  if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS);
  return event;
}
function compareResult(a, b) {
  if (a.score !== b.score) return a.score > b.score ? 1 : -1;
  if (a.rating !== b.rating) return a.rating > b.rating ? 1 : -1;
  if (a.misses !== b.misses) return a.misses < b.misses ? 1 : -1;
  return 0;
}

async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return send(res, 200, { ok: true });
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/" && req.method === "GET") {
      const page = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VersusNet</title><style>body{font:16px system-ui;background:#10101c;color:#f6f4ff;max-width:720px;margin:12vh auto;padding:24px}h1{color:#80ffb1}a{color:#80ffb1}</style><h1>VersusNet</h1><p>Servidor de salas 1 vs 1</p><p id="state">Revisando…</p><script>fetch('/health').then(r=>r.json()).then(x=>document.querySelector('#state').textContent=x.ok?'Servidor en línea':'Servidor no disponible').catch(()=>document.querySelector('#state').textContent='Sin conexión');</script></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page);
    }
    if (url.pathname === "/health" && req.method === "GET") return send(res, 200, { ok: true });

    if (url.pathname === "/v1/rooms" && req.method === "GET") {
      const list = [...rooms.values()].filter(room => room.visibility === "public" && room.players.length < 2)
        .sort((a, b) => a.created - b.created).map(publicRoom);
      return send(res, 200, { rooms: list });
    }
    if (url.pathname === "/v1/rooms" && req.method === "POST") {
      const body = await readJson(req);
      const visibility = body.visibility === "private" ? "private" : "public";
      const password = String(body.password || "");
      if (visibility === "private" && (password.length < 4 || password.length > 24))
        return send(res, 400, { error: "La contraseña privada debe tener entre 4 y 24 caracteres" });
      const code = makeCode();
      const host = { token: makeToken(), name: cleanName(body.name), seen: Date.now(), ready: false, songVote: null, score: 0, misses: 0, rating: 0, result: null };
      const room = { code, visibility, password: visibility === "private" ? passwordRecord(password) : null,
        players: [host], song: null, phase: "waiting", events: [], seq: 0, created: Date.now() };
      rooms.set(code, room);
      return send(res, 201, { code, token: host.token, player: 1, visibility });
    }

    const parts = url.pathname.split("/");
    const code = parts[3] || "";
    const action = parts[4] || "";
    if (parts.length !== 5 || parts[1] !== "v1" || parts[2] !== "rooms" || !/^[A-Z0-9]{4,8}$/.test(code) || !["join", "poll", "events", "leave", "state"].includes(action))
      return send(res, 404, { error: "ruta no encontrada" });
    const room = rooms.get(code);
    if (!room) return send(res, 404, { error: "la sala no existe o expiró" });

    if (action === "join" && req.method === "POST") {
      const body = await readJson(req);
      if (room.players.length >= 2) return send(res, 409, { error: "la sala está llena" });
      if (!passwordMatches(room.password, body.password)) return send(res, 403, { error: "contraseña incorrecta" });
      const player = { token: makeToken(), name: cleanName(body.name), seen: Date.now(), ready: false, songVote: null, score: 0, misses: 0, rating: 0, result: null };
      room.players.push(player);
      pushEvent(room, player, "player_joined", { name: player.name });
      return send(res, 200, { code, token: player.token, player: 2, host: room.players[0].name, song: room.song, phase: room.phase });
    }

    if (action === "poll" && req.method === "GET") {
      const player = findPlayer(room, url.searchParams.get("token"));
      if (!player) return send(res, 403, { error: "token de jugador inválido" });
      player.seen = Date.now();
      const since = Number(url.searchParams.get("since") || 0);
      const opponent = room.players.find(other => other !== player);
      return send(res, 200, { code, visibility: room.visibility, song: room.song, phase: room.phase,
        self: { name: player.name, ready: player.ready, songVote: player.songVote, score: player.score, misses: player.misses, rating: player.rating, result: player.result },
        opponent: opponent ? { name: opponent.name, ready: opponent.ready, songVote: opponent.songVote, score: opponent.score, misses: opponent.misses, rating: opponent.rating, result: opponent.result } : null,
        events: room.events.filter(event => event.seq > since && event.from !== player.token)
          .map(({ seq, kind, payload, at }) => ({ seq, kind, payload, at })) });
    }

    if (action === "state" && req.method === "GET") {
      const player = findPlayer(room, url.searchParams.get("token"));
      if (!player) return send(res, 403, { error: "token de jugador inválido" });
      player.seen = Date.now();
      return send(res, 200, { room: publicRoom(room), players: room.players.map(p => ({ name: p.name, ready: p.ready, score: p.score, misses: p.misses, rating: p.rating })) });
    }

    if (action === "events" && req.method === "POST") {
      const body = await readJson(req);
      const player = findPlayer(room, body.token);
      if (!player) return send(res, 403, { error: "token de jugador inválido" });
      player.seen = Date.now();
      const kind = String(body.kind || "");
      const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
      if (kind === "song_select") {
        if (room.phase === "playing") return send(res, 409, { error: "la canción no se puede cambiar durante la partida" });
        const song = cleanSong(payload.song);
        if (!song) return send(res, 400, { error: "canción inválida" });
        player.songVote = song;
        for (const p of room.players) { p.ready = false; p.result = null; }
        const votes = room.players.map(p => p.songVote);
        room.song = votes.length === 2 && votes[0] && votes[0] === votes[1] ? song : null;
        room.phase = room.song ? "song_select" : "voting";
      } else if (kind === "ready") {
        if (!room.song || room.players.length < 2) return send(res, 409, { error: "se necesita rival y canción" });
        player.ready = !!payload.ready;
        if (room.players.length === 2 && room.players.every(p => p.ready)) {
          room.phase = "playing";
          for (const p of room.players) { p.score = 0; p.misses = 0; p.rating = 0; p.result = null; }
          pushEvent(room, null, "match_start", { song: room.song, at: Date.now() });
        }
      } else if (kind === "score") {
        player.score = Math.max(0, Math.min(2_000_000_000, Math.floor(Number(payload.score) || 0)));
        player.misses = Math.max(0, Math.min(10_000_000, Math.floor(Number(payload.misses) || 0)));
        player.rating = Math.max(0, Math.min(100, Number(payload.rating) || 0));
      } else if (kind === "match_result") {
        if (room.phase !== "playing") return send(res, 409, { error: "la partida no está en curso" });
        player.result = { score: Math.max(0, Math.floor(Number(payload.score) || 0)),
          misses: Math.max(0, Math.floor(Number(payload.misses) || 0)), rating: Math.max(0, Math.min(100, Number(payload.rating) || 0)) };
        player.score = player.result.score; player.misses = player.result.misses; player.rating = player.result.rating;
        if (room.players.length === 2 && room.players.every(p => p.result)) {
          const [a, b] = room.players;
          const cmp = compareResult(a.result, b.result);
          const winner = cmp === 0 ? null : (cmp > 0 ? a : b);
          room.phase = "results";
          pushEvent(room, null, "final_result", { winner: winner?.name || "Empate", winnerToken: winner?.token || null,
            players: room.players.map(p => ({ name: p.name, score: p.result.score, misses: p.result.misses, rating: p.result.rating })) });
        }
      } else if (kind === "chat") {
        payload.text = String(payload.text || "").replace(/[<>]/g, "").split(String.fromCharCode(10)).join("").split(String.fromCharCode(13)).join("").slice(0, 180);
        payload.name = player.name;
      } else if (kind === "select_side") {
        if (payload.side !== "bf" && payload.side !== "opponent") return send(res, 400, { error: "lado inválido" });
      } else return send(res, 400, { error: "evento desconocido" });

      const event = pushEvent(room, player, kind, payload);
      return send(res, 200, { ok: true, seq: event.seq, phase: room.phase, song: room.song });
    }

    if (action === "leave" && req.method === "POST") {
      const body = await readJson(req);
      const player = findPlayer(room, body.token);
      if (!player) return send(res, 403, { error: "token de jugador inválido" });
      room.players = room.players.filter(p => p !== player);
      pushEvent(room, null, "player_left", { name: player.name });
      if (room.players.length === 0) rooms.delete(code);
      else {
        room.phase = "waiting"; room.song = null;
        room.players[0].ready = false; room.players[0].result = null; room.players[0].songVote = null;
      }
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: "método no permitido" });
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : "error interno" });
    else res.destroy();
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    room.players = room.players.filter(player => now - player.seen < ROOM_TTL_MS);
    if (room.players.length === 0 || now - room.created > 6 * 60 * 60 * 1000) rooms.delete(code);
    else if (room.players.length === 1 && room.phase !== "waiting") {
      room.phase = "waiting"; room.song = null;
      room.players[0].ready = false; room.players[0].result = null; room.players[0].songVote = null;
    }
  }
}, 15_000).unref();
http.createServer(handler).listen(PORT, "0.0.0.0", () => console.log("VersusNet lobby listening on " + PORT));
