/**
 * MAX MILITIA multiplayer server. Plain Node + `ws`.
 *
 *   PORT                  listen port (default 8787; hosts like Render/Railway set it for you)
 *   HOST                  bind address (default 0.0.0.0)
 *   ALLOWED_ORIGINS       comma separated list of browser origins allowed to connect, e.g.
 *                         https://maxmilitia.vercel.app,http://localhost:5173 . Empty = allow all (dev only).
 *   MAX_PLAYERS_PER_ROOM  default 6
 *   MAX_ROOMS             default 50
 *   MAX_CONNECTIONS_PER_IP default 12
 */
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { DEFAULT_OPTIONS, GameServer, type Connection } from './rooms'

const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback
const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

const PORT = num('PORT', 8787)
const HOST = env('HOST', '0.0.0.0')
const ALLOWED = env('ALLOWED_ORIGINS', '').split(',').map(s => s.trim()).filter(Boolean)
const MAX_PER_IP = num('MAX_CONNECTIONS_PER_IP', 12)

const game = new GameServer({
  ...DEFAULT_OPTIONS,
  maxPlayers: Math.min(6, Math.max(2, Math.floor(num('MAX_PLAYERS_PER_ROOM', DEFAULT_OPTIONS.maxPlayers)))),
  maxRooms: Math.floor(num('MAX_ROOMS', DEFAULT_OPTIONS.maxRooms)),
})

const http = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, name: 'max-militia-server', ...game.stats() }))
    return
  }
  res.writeHead(404).end()
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
const perIp = new Map<string, number>()

http.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin
  if (ALLOWED.length && (!origin || !ALLOWED.includes(origin))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  const forwarded = req.headers['x-forwarded-for']
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])?.trim() || req.socket.remoteAddress || 'unknown'
  if ((perIp.get(ip) ?? 0) >= MAX_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => {
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
    attach(ws, ip)
  })
})

function attach(ws: WebSocket, ip: string): void {
  let alive = true
  const conn: Connection = game.connect({
    send: data => { if (ws.readyState === ws.OPEN) ws.send(data) },
    close: (code, reason) => ws.close(code, reason),
  })
  ws.on('pong', () => { alive = true })
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    game.onMessage(conn, data.toString('utf8'))
  })
  const beat = setInterval(() => {
    if (!alive) { ws.terminate(); return }
    alive = false
    ws.ping()
  }, 15_000)
  ws.on('close', () => {
    clearInterval(beat)
    perIp.set(ip, Math.max(0, (perIp.get(ip) ?? 1) - 1))
    game.disconnect(conn)
  })
  ws.on('error', () => ws.terminate())
}

// Fixed-rate loop driven by real elapsed time (setInterval drifts, so measure it).
let last = performance.now()
setInterval(() => {
  const now = performance.now()
  game.advance((now - last) / 1000)
  last = now
}, 8)
setInterval(() => game.sweep(), 1000)

http.listen(PORT, HOST, () => {
  console.log(`[max-militia] listening on ${HOST}:${PORT} (origins: ${ALLOWED.length ? ALLOWED.join(', ') : 'any'})`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[max-militia] ${sig}, shutting down`)
    wss.clients.forEach(c => c.close(1001, 'server restarting'))
    http.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
