/**
 * A Session is everything the Game needs from "the world": the local player's state, the other
 * players, grenades, pickups and match info. `LocalSession` runs the shared MatchSim in the
 * browser (practice mode, no network). `RemoteSession` mirrors a server-authoritative match with
 * client-side prediction, reconciliation and snapshot interpolation.
 */
import { ARENA } from '../shared/arenaData'
import type { Bounds } from '../shared/arenaData'
import type { CollisionWorld } from '../shared/collision'
import type { Cosmetics } from '../shared/cosmetics'
import { applyYou, MatchSim, STEP, type DummySnap, type GasSnap, type GrenadeSnap, type MatchPhase, type NetEvent, type PlayerSnap, type Snapshot } from '../shared/match'
import { PlayerState, stepPlayer, type InputFrame, type SimEvent } from '../shared/playerSim'
import { buildWorld } from '../shared/arenaData'
import type { RoomClient } from './room'

export type PlayerView = {
  id: string; name: string; team: number; cosmetics: Cosmetics
  x: number; y: number; z: number; yaw: number; pitch: number
  hp: number; dead: boolean; weapon: string; thrusting: boolean; grounded: boolean; emote: boolean; protect: boolean
  speed: number
}
export type MatchInfo = { phase: MatchPhase; timeLeft: number; scores: number[]; killLimit: number; practice: boolean }
export type MyInfo = { health: number; dead: boolean; respawnLeft: number; protect: boolean; team: number }
export type ScoreRow = { id: string; name: string; team: number; kills: number; deaths: number; me: boolean }

export interface Session {
  readonly kind: 'practice' | 'online'
  readonly localId: string
  readonly world: CollisionWorld
  readonly bounds: Bounds
  readonly me: PlayerState
  /** Position before the last fixed step (for render interpolation). */
  readonly prev: { x: number; y: number; z: number }
  readonly info: MyInfo
  readonly match: MatchInfo
  readonly pickups: readonly string[]
  readonly dummies: readonly DummySnap[]
  readonly clouds: readonly GasSnap[]
  /** Input latency estimate in ms reported to the server for hit rewinding. */
  readonly lagMs: number
  readonly rtt: number
  step(frame: InputFrame, dt: number): SimEvent[]
  /** Smoothing offset to add to the local render position after server corrections. */
  correction(dt: number): { x: number; y: number; z: number }
  others(now: number): PlayerView[]
  grenades(now: number): GrenadeSnap[]
  takeEvents(): NetEvent[]
  scoreboard(): ScoreRow[]
  nameOf(id: string): string
  teamOf(id: string): number
  close(): void
}

const ZERO = { x: 0, y: 0, z: 0 }

// ---- Practice ------------------------------------------------------------------------------------
export class LocalSession implements Session {
  readonly kind = 'practice' as const
  readonly localId = 'me'
  readonly world: CollisionWorld
  readonly bounds: Bounds
  readonly me: PlayerState
  readonly prev = { x: 0, y: 0, z: 0 }
  readonly info: MyInfo = { health: 100, dead: false, respawnLeft: 0, protect: false, team: 0 }
  readonly match: MatchInfo = { phase: 'live', timeLeft: 0, scores: [0, 0], killLimit: 0, practice: true }
  readonly lagMs = 0
  readonly rtt = 0
  pickups: string[] = []
  dummies: DummySnap[] = []
  clouds: GasSnap[] = []
  private readonly sim: MatchSim
  private readonly player
  private seq = 0
  private queue: NetEvent[] = []
  private local: SimEvent[] = []
  private grenadeSnaps: GrenadeSnap[] = []

  constructor(private readonly name: string, cosmetics: Cosmetics) {
    this.sim = new MatchSim({ mode: 'practice' })
    this.world = this.sim.world
    this.bounds = this.sim.bounds
    this.player = this.sim.addPlayer('me', name, cosmetics, 0)
    this.me = this.player.state
    this.sim.playerEvents = (p, ev) => { if (p.id === 'me') this.local.push(...ev) }
    this.copyPrev()
    this.refresh()
  }

  private copyPrev(): void {
    const b = this.me.body
    this.prev.x = b.x; this.prev.y = b.y; this.prev.z = b.z
  }

  step(frame: InputFrame, dt: number): SimEvent[] {
    this.copyPrev()
    this.sim.pushInputs('me', [{ ...frame, seq: this.seq++ }])
    this.sim.step(dt)
    this.refresh()
    const out = this.local
    this.local = []
    return out
  }

  private refresh(): void {
    const p = this.player
    this.info.health = p.health
    this.info.dead = p.dead
    this.info.respawnLeft = p.respawnLeft
    this.info.protect = p.protectLeft > 0
    const snap = this.sim.shared()
    this.pickups = snap.pk
    this.dummies = snap.d
    this.clouds = snap.gas
    this.grenadeSnaps = snap.g
    this.queue.push(...this.sim.drainEvents())
  }

  correction(): { x: number; y: number; z: number } { return ZERO }
  others(): PlayerView[] { return [] }
  grenades(): GrenadeSnap[] { return this.grenadeSnaps }
  takeEvents(): NetEvent[] { const q = this.queue; this.queue = []; return q }
  scoreboard(): ScoreRow[] { return [{ id: 'me', name: this.name, team: 0, kills: this.player.kills, deaths: this.player.deaths, me: true }] }
  nameOf(id: string): string { return id === 'me' ? this.name : id.startsWith('dummy:') ? 'Target' : 'Unknown' }
  teamOf(): number { return 0 }
  close(): void { this.sim.playerEvents = null }
}

// ---- Online --------------------------------------------------------------------------------------
type Stamped = { snap: Snapshot; recv: number }
const INTERP_MS = 100
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const lerpAngle = (a: number, b: number, t: number): number => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t

export class RemoteSession implements Session {
  readonly kind = 'online' as const
  readonly world = buildWorld()
  readonly bounds = ARENA.bounds
  readonly me = new PlayerState()
  readonly prev = { x: 0, y: 0, z: 0 }
  readonly info: MyInfo = { health: 100, dead: false, respawnLeft: 0, protect: false, team: 0 }
  readonly match: MatchInfo = { phase: 'countdown', timeLeft: 0, scores: [0, 0], killLimit: 0, practice: false }
  pickups: string[] = []
  dummies: DummySnap[] = []
  clouds: GasSnap[] = []
  private buffer: Stamped[] = []
  private pending: InputFrame[] = []
  private seq = 0
  private queue: NetEvent[] = []
  private offset = { x: 0, y: 0, z: 0 }
  private spawned = false
  private latest: Snapshot | null = null
  private recvLatest = 0

  constructor(private readonly room: RoomClient) {
    room.onSnapshot = s => this.ingest(s)
  }

  get localId(): string { return this.room.myId }
  get rtt(): number { return this.room.rtt }
  get lagMs(): number { return INTERP_MS + this.room.rtt / 2 }

  private copyPrev(): void {
    const b = this.me.body
    this.prev.x = b.x; this.prev.y = b.y; this.prev.z = b.z
  }

  step(frame: InputFrame, dt: number): SimEvent[] {
    this.copyPrev()
    const events: SimEvent[] = []
    const f = { ...frame, seq: this.seq++, lag: Math.round(this.lagMs) }
    if (this.match.phase === 'live' && !this.info.dead && this.spawned) {
      stepPlayer(this.me, f, dt, this, events)
      this.pending.push(f)
      if (this.pending.length > 180) this.pending.shift()
    }
    // Always send (the server ignores input outside a live match) so acks keep flowing; batch every 2 ticks.
    this.outbox.push(f)
    if (this.outbox.length >= 2) this.flush()
    return events
  }

  private outbox: InputFrame[] = []
  private flush(): void {
    if (!this.outbox.length) return
    this.room.send({ t: 'input', frames: this.outbox.splice(0, 10) })
  }

  private ingest(s: Snapshot): void {
    const now = performance.now()
    this.latest = s
    this.recvLatest = now
    this.buffer.push({ snap: s, recv: now })
    if (this.buffer.length > 40) this.buffer.shift()
    for (const e of s.ev) this.queue.push(e)
    this.match.phase = s.ph
    this.match.timeLeft = s.tl
    this.match.scores = s.sc
    this.match.killLimit = s.kl
    this.pickups = s.pk
    this.dummies = s.d
    this.clouds = s.gas
    const mine = s.p.find(p => p.i === this.localId)
    if (mine) this.info.team = mine.t
    if (!s.you) return
    this.info.health = s.you.hp
    this.info.dead = s.you.dead
    this.info.respawnLeft = s.you.rs
    this.info.protect = s.you.pr > 0

    // Reconcile: adopt the server state, then replay inputs it has not processed yet.
    const before = { x: this.me.body.x, y: this.me.body.y, z: this.me.body.z }
    const firstTime = !this.spawned
    applyYou(this.me, s.you)
    this.pending = this.pending.filter(f => f.seq > s.ack)
    if (s.ph === 'live' && !s.you.dead) {
      const sink: SimEvent[] = []
      for (const f of this.pending) stepPlayer(this.me, f, STEP, this, sink)
    } else this.pending = []
    this.spawned = true
    if (firstTime) { this.copyPrev(); this.offset = { x: 0, y: 0, z: 0 }; return }
    const dx = before.x - this.me.body.x
    const dy = before.y - this.me.body.y
    const dz = before.z - this.me.body.z
    if (Math.hypot(dx, dy, dz) > 2.5) this.offset = { x: 0, y: 0, z: 0 } // teleport (respawn): snap
    else { this.offset.x += dx; this.offset.y += dy; this.offset.z += dz }
  }

  correction(dt: number): { x: number; y: number; z: number } {
    const k = Math.exp(-12 * dt)
    this.offset.x *= k; this.offset.y *= k; this.offset.z *= k
    return this.offset
  }

  /** Server time estimate minus the interpolation delay, clamped to the buffered range. */
  private renderTime(now: number): number {
    const last = this.buffer[this.buffer.length - 1]
    if (!last) return 0
    const est = last.snap.ms + (now - last.recv)
    return Math.min(est - INTERP_MS, last.snap.ms)
  }

  private bracket(now: number): { a: Snapshot; b: Snapshot; t: number } | null {
    const buf = this.buffer
    if (!buf.length) return null
    const rt = this.renderTime(now)
    if (rt <= buf[0].snap.ms) return { a: buf[0].snap, b: buf[0].snap, t: 0 }
    for (let i = buf.length - 1; i > 0; i--) {
      if (buf[i - 1].snap.ms <= rt) {
        const a = buf[i - 1].snap
        const b = buf[i].snap
        const span = b.ms - a.ms
        return { a, b, t: span > 0 ? Math.min(1, (rt - a.ms) / span) : 1 }
      }
    }
    return { a: buf[0].snap, b: buf[0].snap, t: 0 }
  }

  others(now: number): PlayerView[] {
    const br = this.bracket(now)
    if (!br) return []
    const prevById = new Map<string, PlayerSnap>(br.a.p.map(p => [p.i, p]))
    const out: PlayerView[] = []
    for (const p of br.b.p) {
      if (p.i === this.localId) continue
      const q = prevById.get(p.i) ?? p
      const info = this.room.roster.find(r => r.id === p.i)
      const x = lerp(q.x, p.x, br.t), y = lerp(q.y, p.y, br.t), z = lerp(q.z, p.z, br.t)
      const dt = Math.max(0.001, (br.b.ms - br.a.ms) / 1000)
      out.push({
        id: p.i, name: info?.name ?? '???', team: p.t, cosmetics: info?.cosmetics ?? ({} as Cosmetics),
        x, y, z, yaw: lerpAngle(q.yw, p.yw, br.t), pitch: lerp(q.pt, p.pt, br.t),
        hp: p.hp, dead: p.d === 1, weapon: p.w, thrusting: p.th === 1, grounded: p.gr === 1, emote: p.em === 1, protect: p.pr === 1,
        speed: Math.min(1, Math.hypot(p.x - q.x, p.z - q.z) / dt / 11),
      })
    }
    return out
  }

  grenades(now: number): GrenadeSnap[] {
    const br = this.bracket(now)
    if (!br) return []
    const prevById = new Map<number, GrenadeSnap>(br.a.g.map(g => [g.i, g]))
    return br.b.g.map(g => {
      const q = prevById.get(g.i)
      return q ? { ...g, x: lerp(q.x, g.x, br.t), y: lerp(q.y, g.y, br.t), z: lerp(q.z, g.z, br.t) } : g
    })
  }

  takeEvents(): NetEvent[] { const q = this.queue; this.queue = []; return q }

  scoreboard(): ScoreRow[] {
    const snap = this.latest
    if (!snap) return []
    return snap.p.map(p => ({ id: p.i, name: this.nameOf(p.i), team: p.t, kills: p.k, deaths: p.de, me: p.i === this.localId }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
  }

  nameOf(id: string): string {
    if (id.startsWith('dummy:')) return 'Target'
    return this.room.roster.find(r => r.id === id)?.name ?? 'Unknown'
  }
  teamOf(id: string): number { return this.latest?.p.find(p => p.i === id)?.t ?? this.room.roster.find(r => r.id === id)?.team ?? 0 }
  close(): void { this.flush(); this.room.onSnapshot = () => undefined; void this.recvLatest }
}
