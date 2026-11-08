/**
 * Rooms, lobbies and the authoritative match loop, independent of the network transport so it can
 * be unit tested with fake peers. `server/index.ts` plugs real WebSockets into it.
 */
import { randomBytes } from 'node:crypto'
import { MatchSim, STEP, type Snapshot } from '../src/shared/match'
import {
  DEFAULT_SETTINGS, parseClientMessage, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, PROTOCOL_VERSION,
  type ClientMessage, type ErrorCode, type ResultRow, type RoomSettings, type RosterEntry, type ServerMessage,
} from '../src/shared/protocol'
import type { Cosmetics } from '../src/shared/cosmetics'

export interface Peer {
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type ServerOptions = {
  maxPlayers: number
  maxRooms: number
  graceMs: number
  emptyRoomMs: number
  /** Messages per second sustained / burst capacity of the per-connection token bucket. */
  rateSustained: number
  rateBurst: number
  now?: () => number
  rng?: () => number
}

export const DEFAULT_OPTIONS: ServerOptions = {
  maxPlayers: 6, maxRooms: 50, graceMs: 20_000, emptyRoomMs: 60_000, rateSustained: 120, rateBurst: 240,
}

export class Connection {
  client: Client | null = null
  tokens: number
  lastRefill: number
  strikes = 0
  constructor(readonly peer: Peer, burst: number, now: number) {
    this.tokens = burst
    this.lastRefill = now
  }
}

type Client = {
  id: string
  token: string
  name: string
  cosmetics: Cosmetics
  team: number
  conn: Connection | null
  room: Room
  disconnectedAt: number | null
  joinOrder: number
}

type Room = {
  code: string
  clients: Map<string, Client>
  hostId: string
  state: 'lobby' | 'match' | 'results'
  settings: RoomSettings
  sim: MatchSim | null
  lastActive: number
  joinCounter: number
  resultsSent: boolean
}

export class GameServer {
  readonly rooms = new Map<string, Room>()
  private accumulator = 0
  private readonly now: () => number
  private readonly rng: () => number

  constructor(readonly options: ServerOptions = DEFAULT_OPTIONS) {
    this.now = options.now ?? (() => Date.now())
    this.rng = options.rng ?? Math.random
  }

  // ---- transport entry points ----------------------------------------------------------------
  connect(peer: Peer): Connection {
    const conn = new Connection(peer, this.options.rateBurst, this.now())
    this.sendRaw(peer, { t: 'hello', v: PROTOCOL_VERSION, maxPlayers: this.options.maxPlayers })
    return conn
  }

  disconnect(conn: Connection): void {
    const client = conn.client
    if (!client || client.conn !== conn) return
    client.conn = null
    client.disconnectedAt = this.now()
    const p = client.room.sim?.players.get(client.id)
    if (p) p.connected = false
    this.broadcastLobby(client.room)
  }

  onMessage(conn: Connection, raw: string): void {
    const now = this.now()
    // Token bucket rate limit.
    conn.tokens = Math.min(this.options.rateBurst, conn.tokens + ((now - conn.lastRefill) / 1000) * this.options.rateSustained)
    conn.lastRefill = now
    if (conn.tokens < 1) {
      conn.strikes++
      if (conn.strikes === 1 || conn.strikes % 20 === 0) this.error(conn, 'rate_limited', 'Slow down')
      if (conn.strikes >= 100) conn.peer.close(1008, 'rate limited')
      return
    }
    conn.tokens -= 1
    if (typeof raw !== 'string' || raw.length > 16_384) return this.error(conn, 'bad_message', 'Message too large')
    const parsed = parseClientMessage(raw)
    if (!parsed.ok) return this.error(conn, parsed.code, parsed.message)
    this.handle(conn, parsed.msg)
  }

  // ---- message handling ----------------------------------------------------------------------
  private handle(conn: Connection, msg: ClientMessage): void {
    if (msg.t === 'ping') return this.sendRaw(conn.peer, { t: 'pong', c: msg.c, s: this.now() })
    if (msg.t === 'create') return this.create(conn, msg)
    if (msg.t === 'join') return this.join(conn, msg)
    if (msg.t === 'resume') return this.resume(conn, msg)
    const client = conn.client
    if (!client) return this.error(conn, 'bad_state', 'Join a room first')
    const room = client.room
    switch (msg.t) {
      case 'input': {
        if (room.state !== 'match') return
        room.sim?.pushInputs(client.id, msg.frames)
        return
      }
      case 'cosmetics': {
        client.cosmetics = msg.cosmetics
        const p = room.sim?.players.get(client.id)
        if (p) p.cosmetics = msg.cosmetics
        return this.broadcastLobby(room)
      }
      case 'settings': {
        if (client.id !== room.hostId) return this.error(conn, 'not_host', 'Only the host can change settings')
        if (room.state !== 'lobby') return this.error(conn, 'bad_state', 'Match already running')
        room.settings = msg.settings
        return this.broadcastLobby(room)
      }
      case 'start': {
        if (client.id !== room.hostId) return this.error(conn, 'not_host', 'Only the host can start')
        if (room.state !== 'lobby') return this.error(conn, 'bad_state', 'Match already running')
        return this.startMatch(room)
      }
      case 'leave': {
        this.removeClient(client, 'left')
        return
      }
    }
  }

  private newRoomCode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = ''
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[Math.floor(this.rng() * ROOM_CODE_ALPHABET.length)]
      if (!this.rooms.has(code)) return code
    }
    throw new Error('could not allocate a room code')
  }

  private newClient(conn: Connection, room: Room, name: string, cosmetics: Cosmetics): Client {
    let id = ''
    do { id = randomBytes(3).toString('hex') } while (room.clients.has(id))
    const counts = [0, 0]
    for (const c of room.clients.values()) counts[c.team]++
    const client: Client = {
      id, token: randomBytes(16).toString('hex'), name, cosmetics, team: counts[0] <= counts[1] ? 0 : 1,
      conn, room, disconnectedAt: null, joinOrder: room.joinCounter++,
    }
    room.clients.set(id, client)
    conn.client = client
    return client
  }

  private create(conn: Connection, msg: Extract<ClientMessage, { t: 'create' }>): void {
    if (conn.client) return this.error(conn, 'bad_state', 'Already in a room')
    if (this.rooms.size >= this.options.maxRooms) return this.error(conn, 'server_busy', 'Server is full, try again soon')
    const room: Room = {
      code: this.newRoomCode(), clients: new Map(), hostId: '', state: 'lobby', settings: { ...DEFAULT_SETTINGS },
      sim: null, lastActive: this.now(), joinCounter: 0, resultsSent: false,
    }
    this.rooms.set(room.code, room)
    const client = this.newClient(conn, room, msg.name, msg.cosmetics)
    room.hostId = client.id
    this.sendRaw(conn.peer, { t: 'welcome', id: client.id, code: room.code, token: client.token })
    this.broadcastLobby(room)
  }

  private join(conn: Connection, msg: Extract<ClientMessage, { t: 'join' }>): void {
    if (conn.client) return this.error(conn, 'bad_state', 'Already in a room')
    const room = this.rooms.get(msg.code)
    if (!room) return this.error(conn, 'no_room', 'No room with that code')
    if (room.clients.size >= this.options.maxPlayers) return this.error(conn, 'room_full', 'That room is full')
    const client = this.newClient(conn, room, msg.name, msg.cosmetics)
    this.sendRaw(conn.peer, { t: 'welcome', id: client.id, code: room.code, token: client.token })
    if (room.state === 'match' && room.sim) room.sim.addPlayer(client.id, client.name, client.cosmetics, client.team)
    this.broadcastLobby(room)
  }

  private resume(conn: Connection, msg: Extract<ClientMessage, { t: 'resume' }>): void {
    if (conn.client) return this.error(conn, 'bad_state', 'Already in a room')
    const room = this.rooms.get(msg.code)
    const client = room && [...room.clients.values()].find(c => c.token === msg.token)
    if (!room || !client) return this.error(conn, 'bad_token', 'This session has expired')
    client.conn?.peer.close(4000, 'replaced')
    client.conn = conn
    conn.client = client
    client.disconnectedAt = null
    const p = room.sim?.players.get(client.id)
    if (p) p.connected = true
    this.sendRaw(conn.peer, { t: 'welcome', id: client.id, code: room.code, token: client.token })
    this.broadcastLobby(room)
  }

  private removeClient(client: Client, reason: string): void {
    const room = client.room
    room.clients.delete(client.id)
    room.sim?.removePlayer(client.id)
    if (client.conn) {
      this.sendRaw(client.conn.peer, { t: 'left', reason })
      client.conn.client = null
      client.conn = null
    }
    if (room.clients.size === 0) { this.rooms.delete(room.code); return }
    if (room.hostId === client.id) {
      const next = [...room.clients.values()].filter(c => c.conn).sort((a, b) => a.joinOrder - b.joinOrder)[0] ?? [...room.clients.values()][0]
      room.hostId = next.id
    }
    this.broadcastLobby(room)
  }

  private startMatch(room: Room): void {
    const connected = [...room.clients.values()].filter(c => c.conn)
    if (connected.length < 1) return
    const sim = new MatchSim({ mode: 'versus', killLimit: room.settings.killLimit, timeLimitSeconds: room.settings.timeLimitMinutes * 60, rng: this.rng })
    // Re-balance teams by join order so a lobby that changed during waiting starts evenly.
    connected.sort((a, b) => a.joinOrder - b.joinOrder).forEach((c, i) => { c.team = i % 2 })
    for (const c of connected) sim.addPlayer(c.id, c.name, c.cosmetics, c.team)
    for (const c of room.clients.values()) if (!c.conn) room.clients.delete(c.id)
    room.sim = sim
    room.state = 'match'
    room.resultsSent = false
    this.broadcastLobby(room)
  }

  // ---- loop ----------------------------------------------------------------------------------
  /** Advance the simulation by real elapsed seconds; steps at a fixed 60 Hz and snapshots at 20 Hz. */
  advance(realDt: number): void {
    this.accumulator = Math.min(this.accumulator + realDt, 0.25)
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP
      for (const room of this.rooms.values()) {
        const sim = room.sim
        if (!sim) continue
        sim.step(STEP)
        if (sim.tick % 3 === 0) this.sendSnapshots(room)
        if (sim.phase === 'results' && !room.resultsSent) this.sendResults(room)
        if (sim.phase === 'results' && sim.resultsLeft <= 0) this.endToLobby(room)
      }
    }
  }

  private sendSnapshots(room: Room): void {
    const sim = room.sim!
    const shared = sim.shared()
    shared.ev = sim.drainEvents()
    for (const c of room.clients.values()) {
      if (!c.conn) continue
      const p = sim.players.get(c.id)
      const snap: Snapshot = { ...shared, ack: p ? p.ack : -1, you: sim.you(c.id) }
      this.sendRaw(c.conn.peer, { t: 'snap', s: snap })
    }
  }

  private sendResults(room: Room): void {
    const sim = room.sim!
    room.resultsSent = true
    room.state = 'results'
    const rows: ResultRow[] = [...sim.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths }))
    this.broadcast(room, { t: 'results', scores: [...sim.scores], winner: sim.winner, rows })
    this.broadcastLobby(room)
  }

  private endToLobby(room: Room): void {
    room.sim = null
    room.state = 'lobby'
    room.resultsSent = false
    for (const c of room.clients.values()) if (!c.conn) room.clients.delete(c.id)
    if (room.clients.size === 0) { this.rooms.delete(room.code); return }
    if (!room.clients.has(room.hostId)) room.hostId = [...room.clients.values()][0].id
    this.broadcastLobby(room)
  }

  /** Housekeeping: drop clients whose reconnect grace expired and rooms that have been empty too long. */
  sweep(): void {
    const now = this.now()
    for (const room of [...this.rooms.values()]) {
      for (const c of [...room.clients.values()]) {
        if (c.disconnectedAt !== null && now - c.disconnectedAt > this.options.graceMs) this.removeClient(c, 'timeout')
      }
      const live = this.rooms.get(room.code)
      if (!live) continue
      if ([...live.clients.values()].some(c => c.conn)) live.lastActive = now
      else if (now - live.lastActive > this.options.emptyRoomMs) this.rooms.delete(live.code)
    }
  }

  stats(): { rooms: number; players: number } {
    let players = 0
    for (const r of this.rooms.values()) for (const c of r.clients.values()) if (c.conn) players++
    return { rooms: this.rooms.size, players }
  }

  // ---- output --------------------------------------------------------------------------------
  private roster(room: Room): RosterEntry[] {
    return [...room.clients.values()].sort((a, b) => a.joinOrder - b.joinOrder).map(c => ({
      id: c.id, name: c.name, cosmetics: c.cosmetics, team: c.team, connected: !!c.conn, host: c.id === room.hostId,
    }))
  }

  private broadcastLobby(room: Room): void {
    this.broadcast(room, { t: 'lobby', code: room.code, state: room.state, hostId: room.hostId, roster: this.roster(room), settings: room.settings, max: this.options.maxPlayers })
  }

  private broadcast(room: Room, msg: ServerMessage): void {
    const text = JSON.stringify(msg)
    for (const c of room.clients.values()) c.conn?.peer.send(text)
  }

  private sendRaw(peer: Peer, msg: ServerMessage): void {
    try { peer.send(JSON.stringify(msg)) } catch { /* peer already gone */ }
  }

  private error(conn: Connection, code: ErrorCode, message: string): void {
    this.sendRaw(conn.peer, { t: 'error', code, message })
  }
}
