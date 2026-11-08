/**
 * Authoritative match simulation. Runs on the Node server for rooms and inside the browser for
 * solo practice, so both modes share one set of rules: movement validation (via stepPlayer),
 * hit scan with lag-compensated rewinds, health/damage, grenades, gas clouds, server-rolled weapon
 * pickups, respawns and scoring. No rendering and no networking in here.
 */
import { CollisionWorld } from './collision'
import { CONFIG } from './config'
import { ARENA, buildWorld, type DummySpec } from './arenaData'
import { aimRay, rayCharacter, spreadDirection, torsoPoint } from './hitboxes'
import {
  blastDamage, GRENADE_COMMON, GRENADE_KINDS, GRENADES, stepGrenade,
  type FragDef, type GasDef, type GrenadeBody, type GrenadeKind, type GrenadeStockState, type ProxDef,
} from './grenades'
import { PlayerState, stepPlayer, type InputFrame, type SimEvent } from './playerSim'
import { damageAt, findWeapon, weaponById, type LoadoutState } from './weapons'
import type { Cosmetics } from './cosmetics'
import matchData from '../data/match.json'
import pickupData from '../data/pickups.json'

export const TICK_HZ = 60
export const STEP = 1 / TICK_HZ
export const MATCH_RULES = matchData
export type MatchPhase = 'countdown' | 'live' | 'results'
export type MatchMode = 'practice' | 'versus'

export type MatchOptions = {
  mode: MatchMode
  killLimit?: number
  timeLimitSeconds?: number
  rng?: () => number
}

// ---- Snapshot / event wire types -------------------------------------------------------------
export type PlayerSnap = {
  i: string; x: number; y: number; z: number; yw: number; pt: number; hp: number
  d: 0 | 1; w: string; th: 0 | 1; gr: 0 | 1; k: number; de: number; em: 0 | 1; pr: 0 | 1; t: number
}
/** s: 0 flying, 1 landed/arming, 2 armed, 3 triggered. f: seconds left on the current timer. */
export type GrenadeSnap = { i: number; k: number; x: number; y: number; z: number; s: number; f: number; o: string; tm: number }
export type GasSnap = { i: number; x: number; y: number; z: number; r: number; l: number; tm: number }
export type DummySnap = { i: string; hp: number; a: 0 | 1 }
export type NetEvent =
  | { ev: 'shot'; p: string; w: string; ends: number[][] }
  | { ev: 'hit'; a: string; v: string; d: number; head: boolean; kill: boolean }
  | { ev: 'kill'; k: string; v: string; w: string; head: boolean }
  | { ev: 'throw'; p: string; k: number; id: number }
  | { ev: 'boom'; k: number; x: number; y: number; z: number; r: number }
  | { ev: 'gas'; id: number; x: number; y: number; z: number; r: number; dur: number }
  | { ev: 'armed'; id: number }
  | { ev: 'pickup'; p: string; spot: number; w: string }
  | { ev: 'item'; spot: number; w: string }
  | { ev: 'respawn'; p: string }
  | { ev: 'reload'; p: string }
  | { ev: 'emote'; p: string }
  | { ev: 'phase'; ph: MatchPhase; winner?: number }

export type YouState = {
  x: number; y: number; z: number; vx: number; vy: number; vz: number
  jet: { fuel: number; idle: number; hold: number; locked: boolean; thrusting: boolean }
  gr: boolean; air: number; coy: number
  lo: LoadoutState; gs: GrenadeStockState
  hp: number; dead: boolean; rs: number; pr: number
}
export type SnapshotShared = {
  t: number; ms: number; ph: MatchPhase; tl: number; sc: number[]; kl: number
  p: PlayerSnap[]; g: GrenadeSnap[]; gas: GasSnap[]; pk: string[]; d: DummySnap[]; ev: NetEvent[]
}
export type Snapshot = SnapshotShared & { ack: number; you: YouState | null }

// ---- Simulation entities ---------------------------------------------------------------------
export type SimPlayer = {
  id: string
  name: string
  cosmetics: Cosmetics
  team: number
  state: PlayerState
  health: number
  dead: boolean
  respawnLeft: number
  protectLeft: number
  kills: number
  deaths: number
  queue: InputFrame[]
  credit: number
  lastSeq: number
  ack: number
  yaw: number
  pitch: number
  lagTicks: number
  emoteLeft: number
  connected: boolean
  history: { x: number; y: number; z: number }[]
  lastDamager: { id: string; t: number } | null
  lastInput: InputFrame | null
  /** Input frames actually simulated (for budget checks and diagnostics). */
  framesProcessed: number
}

type SimGrenade = GrenadeBody & {
  id: number; kind: number; owner: string; team: number; age: number
  /** 0 flying, 1 landed (gas delay / prox arming), 2 armed (prox), 3 triggered (prox) */
  phase: number
  timer: number
}
type SimGas = { id: number; owner: string; team: number; x: number; y: number; z: number; r: number; left: number; tickLeft: number; def: GasDef }
export type SimDummy = { spec: DummySpec; hp: number; alive: boolean; respawnLeft: number }
type PickupState = { weapon: string | null; timer: number; age: number }

const r2 = (v: number): number => Math.round(v * 100) / 100
const HISTORY = 24

function neutralFrame(): InputFrame {
  return { seq: 0, mx: 0, my: 0, sprint: false, jumpHeld: false, jumpPressed: false, fireHeld: false, firePressed: false, reload: false, slot: -1, throw: false, gsel: -1, yaw: 0, pitch: 0, lag: 0, emote: false }
}

export class MatchSim {
  readonly world: CollisionWorld = buildWorld()
  readonly bounds = ARENA.bounds
  readonly players = new Map<string, SimPlayer>()
  readonly dummies: SimDummy[] = []
  readonly grenades: SimGrenade[] = []
  readonly clouds: SimGas[] = []
  readonly pickups: PickupState[] = ARENA.pickups.map((_, i) => ({ weapon: null, timer: pickupData.firstSpawnDelay + i * 0.6, age: 0 }))
  phase: MatchPhase
  tick = 0
  time = 0
  scores = [0, 0]
  timeLeft: number
  readonly killLimit: number
  resultsLeft = 0
  winner = -1
  private events: NetEvent[] = []
  /** Optional observer for each simulated step's low-level events (used by the browser for local effects). */
  playerEvents: ((p: SimPlayer, events: SimEvent[]) => void) | null = null
  private nextId = 1
  private phaseLeft = 0
  private readonly rng: () => number

  constructor(readonly options: MatchOptions) {
    this.rng = options.rng ?? Math.random
    this.killLimit = options.mode === 'practice' ? 0 : options.killLimit ?? matchData.defaults.killLimit
    this.timeLeft = options.mode === 'practice' ? 0 : options.timeLimitSeconds ?? matchData.defaults.timeLimitMinutes * 60
    this.phase = options.mode === 'practice' ? 'live' : 'countdown'
    this.phaseLeft = matchData.countdownSeconds
    if (options.mode === 'practice') {
      for (const spec of ARENA.dummies) this.dummies.push({ spec, hp: spec.hp, alive: true, respawnLeft: 0 })
      this.pickups.forEach((p, i) => { p.timer = 1.5 + i * 0.4 })
    }
  }

  // ---- players -------------------------------------------------------------------------------
  addPlayer(id: string, name: string, cosmetics: Cosmetics, team?: number): SimPlayer {
    const t = team ?? this.smallerTeam()
    const p: SimPlayer = {
      id, name, cosmetics, team: t, state: new PlayerState(), health: CONFIG.player.maxHealth, dead: false, respawnLeft: 0,
      protectLeft: 0, kills: 0, deaths: 0, queue: [], credit: 0.05, lastSeq: -1, ack: -1, yaw: 0, pitch: 0, lagTicks: 0,
      emoteLeft: 0, connected: true, history: [], lastDamager: null, lastInput: null, framesProcessed: 0,
    }
    this.players.set(id, p)
    this.spawn(p, false)
    return p
  }

  removePlayer(id: string): void {
    this.players.delete(id)
  }

  private smallerTeam(): number {
    const counts = [0, 0]
    for (const p of this.players.values()) counts[p.team]++
    return counts[0] <= counts[1] ? 0 : 1
  }

  /** Queue validated input frames from a client. Old/duplicate sequence numbers are dropped. */
  pushInputs(id: string, frames: InputFrame[]): void {
    const p = this.players.get(id)
    if (!p) return
    for (const f of frames) {
      if (f.seq <= p.lastSeq) continue
      p.lastSeq = f.seq
      p.queue.push(f)
    }
    while (p.queue.length > 12) p.queue.shift()
  }

  private pickSpawn(p: SimPlayer) {
    const mine = ARENA.spawns.filter(s => s.team === p.team)
    const pool = mine.length ? mine : ARENA.spawns
    const enemies = [...this.players.values()].filter(o => o.id !== p.id && !o.dead && o.team !== p.team)
    const scored = pool.map(s => {
      let min = 999
      for (const e of enemies) min = Math.min(min, Math.hypot(e.state.body.x - s.x, e.state.body.y - s.y, e.state.body.z - s.z))
      for (const d of this.dummies) if (d.alive) min = Math.min(min, Math.hypot(d.spec.x - s.x, d.spec.z - s.z))
      return { s, min }
    })
    const safe = scored.filter(o => o.min >= 14)
    const list = safe.length ? safe : [[...scored].sort((a, b) => b.min - a.min)[0]]
    return list[Math.floor(this.rng() * list.length)].s
  }

  private spawn(p: SimPlayer, announce: boolean): void {
    const s = this.pickSpawn(p)
    p.state.spawn(s.x, s.y, s.z)
    p.state.loadout.resetToStarters()
    p.state.gren.reset()
    p.health = CONFIG.player.maxHealth
    p.dead = false
    p.respawnLeft = 0
    p.protectLeft = matchData.respawnProtectionSeconds
    p.yaw = s.yaw
    p.pitch = 0.12
    p.queue.length = 0
    p.history.length = 0
    p.lastDamager = null
    if (announce) this.events.push({ ev: 'respawn', p: p.id })
  }

  /** Put a player back at a fresh spawn (used when a match starts). */
  respawnNow(id: string): void {
    const p = this.players.get(id)
    if (p) this.spawn(p, false)
  }

  // ---- main step -----------------------------------------------------------------------------
  step(dt: number = STEP): void {
    this.tick++
    this.time += dt

    if (this.phase === 'countdown') {
      this.phaseLeft -= dt
      if (this.phaseLeft <= 0) this.setPhase('live')
    } else if (this.phase === 'results') {
      this.resultsLeft = Math.max(0, this.resultsLeft - dt)
    } else if (this.options.mode === 'versus') {
      this.timeLeft -= dt
      if (this.timeLeft <= 0) this.endMatch()
    }

    const acting = this.phase === 'live'
    for (const p of this.players.values()) {
      if (p.dead) {
        if (acting) {
          p.respawnLeft -= dt
          if (p.respawnLeft <= 0) this.spawn(p, true)
        }
      } else if (acting) this.stepPlayerInputs(p, dt)
      if (p.protectLeft > 0) p.protectLeft = Math.max(0, p.protectLeft - dt)
      if (p.emoteLeft > 0) p.emoteLeft = Math.max(0, p.emoteLeft - dt)
      const b = p.state.body
      p.history.push({ x: b.x, y: b.y, z: b.z })
      if (p.history.length > HISTORY) p.history.shift()
    }

    if (this.phase !== 'results') {
      this.stepGrenades(dt)
      this.stepClouds(dt)
      this.stepPickups(dt)
      this.stepDummies(dt)
    }
  }

  private stepPlayerInputs(p: SimPlayer, dt: number): void {
    // Input time budget: a client can never be simulated faster than real time, even if it floods frames.
    p.credit = Math.min(p.credit + dt, 0.12)
    let n = 0
    while (p.queue.length && p.credit >= dt - 1e-9 && n < 3 && !p.dead) {
      const frame = p.queue.shift()!
      p.credit -= dt
      n++
      this.applyFrame(p, frame, dt, false)
    }
    if (n === 0 && !p.connected && !p.dead) {
      // Disconnected players stand still (gravity still applies so they do not float).
      this.applyFrame(p, { ...(p.lastInput ?? neutralFrame()), mx: 0, my: 0, jumpHeld: false, jumpPressed: false, fireHeld: false, firePressed: false, reload: false, slot: -1, throw: false, gsel: -1, emote: false }, dt, true)
    }
  }

  private applyFrame(p: SimPlayer, input: InputFrame, dt: number, synthetic: boolean): void {
    if (!synthetic) { p.ack = input.seq; p.lastInput = input; p.framesProcessed++ }
    p.yaw = input.yaw
    p.pitch = input.pitch
    p.lagTicks = Math.round((input.lag / 1000) * TICK_HZ)
    const events: SimEvent[] = []
    stepPlayer(p.state, input, dt, this, events)
    this.playerEvents?.(p, events)
    if (input.emote && p.emoteLeft <= 0) { p.emoteLeft = 2; this.events.push({ ev: 'emote', p: p.id }) }
    for (const e of events) {
      if (p.dead) break
      switch (e.type) {
        case 'fired': this.resolveShot(p, e.weaponId); break
        case 'throw': this.spawnGrenade(p, e.kind); break
        case 'reloadStart': this.events.push({ ev: 'reload', p: p.id }); break
        case 'fell': this.kill(p, p.lastDamager && this.time - p.lastDamager.t < matchData.lastDamagerCreditSeconds ? p.lastDamager.id : '', 'fall', false); break
        default: break
      }
    }
  }

  // ---- shooting ------------------------------------------------------------------------------
  private resolveShot(p: SimPlayer, weaponId: string): void {
    const def = weaponById(weaponId)
    p.protectLeft = 0
    const b = p.state.body
    const ray = aimRay(b.x, b.y, b.z, p.yaw, p.pitch)
    const move = Math.min(1, p.state.horizontalSpeed / CONFIG.player.sprintSpeed)
    const cone = def.spread + def.spreadMove * move + (p.state.grounded ? 0 : def.spreadAir)
    const lagTicks = Math.max(0, Math.min(HISTORY - 2, p.lagTicks))
    const ends: number[][] = []
    const damageTo = new Map<string, { amount: number; head: boolean }>()

    for (let n = 0; n < def.pellets; n++) {
      const [dx, dy, dz] = spreadDirection(ray, cone, this.rng(), this.rng())
      const world = this.world.raycast(ray.ox, ray.oy, ray.oz, dx, dy, dz, def.range)
      let t = world ? world.t : def.range
      let kind = world ? 1 : 0
      let victim: string | null = null
      let victimHead = false
      for (const o of this.players.values()) {
        if (o.id === p.id || o.dead || o.team === p.team || o.protectLeft > 0) continue
        const pos = o.history.length > lagTicks ? o.history[o.history.length - 1 - lagTicks] : o.state.body
        const h = rayCharacter(pos.x, pos.y, pos.z, ray, dx, dy, dz, t)
        if (h && h.t < t) { t = h.t; victim = o.id; victimHead = h.head; kind = h.head ? 3 : 2 }
      }
      for (const d of this.dummies) {
        if (!d.alive) continue
        const h = rayCharacter(d.spec.x, d.spec.y, d.spec.z, ray, dx, dy, dz, t)
        if (h && h.t < t) { t = h.t; victim = `dummy:${d.spec.id}`; victimHead = h.head; kind = h.head ? 3 : 2 }
      }
      if (victim) {
        const dmg = damageAt(def, t) * (victimHead ? def.headshotMult : 1)
        const cur = damageTo.get(victim) ?? { amount: 0, head: false }
        cur.amount += dmg
        cur.head ||= victimHead
        damageTo.set(victim, cur)
      }
      const wn = world && kind === 1 ? world : null
      ends.push([r2(ray.ox + dx * t), r2(ray.oy + dy * t), r2(ray.oz + dz * t), kind, wn ? wn.nx : 0, wn ? wn.ny : 0, wn ? wn.nz : 0])
    }
    this.events.push({ ev: 'shot', p: p.id, w: weaponId, ends })
    for (const [victim, dmg] of damageTo) this.damage(victim, dmg.amount, p, weaponId, dmg.head)
  }

  /** Apply damage to a player id or a `dummy:<id>` target. */
  private damage(victimId: string, amount: number, attacker: SimPlayer | null, tag: string, head: boolean): void {
    if (victimId.startsWith('dummy:')) {
      const d = this.dummies.find(x => `dummy:${x.spec.id}` === victimId)
      if (!d || !d.alive) return
      d.hp = Math.max(0, d.hp - amount)
      const dead = d.hp <= 0
      if (dead) { d.alive = false; d.respawnLeft = d.spec.respawn }
      if (attacker) this.events.push({ ev: 'hit', a: attacker.id, v: victimId, d: Math.round(amount), head, kill: dead })
      return
    }
    const v = this.players.get(victimId)
    if (!v || v.dead || v.protectLeft > 0 || this.phase !== 'live') return
    const self = attacker?.id === v.id
    v.health = Math.max(0, v.health - amount)
    if (attacker && !self) v.lastDamager = { id: attacker.id, t: this.time }
    const dead = v.health <= 0
    if (attacker) this.events.push({ ev: 'hit', a: attacker.id, v: v.id, d: Math.round(amount), head, kill: dead })
    if (dead) this.kill(v, attacker && !self ? attacker.id : '', tag, head)
  }

  private kill(v: SimPlayer, killerId: string, tag: string, head: boolean): void {
    if (v.dead) return
    v.dead = true
    v.health = 0
    v.respawnLeft = CONFIG.player.respawnSeconds
    v.deaths++
    v.state.jet.thrusting = false
    v.state.body.vx = v.state.body.vz = 0
    const killer = killerId ? this.players.get(killerId) : undefined
    if (killer && killer.id !== v.id && killer.team !== v.team) {
      killer.kills++
      if (this.options.mode === 'versus') this.scores[killer.team]++
    }
    this.events.push({ ev: 'kill', k: killer && killer.id !== v.id ? killer.id : '', v: v.id, w: tag, head })
    if (this.options.mode === 'versus' && this.killLimit > 0 && this.phase === 'live' && Math.max(...this.scores) >= this.killLimit) this.endMatch()
  }

  // ---- grenades ------------------------------------------------------------------------------
  private spawnGrenade(p: SimPlayer, kindIndex: number): void {
    p.protectLeft = 0
    const b = p.state.body
    const ray = aimRay(b.x, b.y, b.z, p.yaw, p.pitch)
    // Start in front of the chest; pull back if a wall is right there.
    const cx = b.x, cy = b.y + 1.3, cz = b.z
    let sx = cx + ray.dx * 0.7, sy = cy + ray.dy * 0.7, sz = cz + ray.dz * 0.7
    const wall = this.world.raycast(cx, cy, cz, ray.dx, ray.dy, ray.dz, 0.7)
    if (wall) { const t = Math.max(0, wall.t - 0.25); sx = cx + ray.dx * t; sy = cy + ray.dy * t; sz = cz + ray.dz * t }
    const c = GRENADE_COMMON
    this.launchGrenade(
      p, kindIndex, sx, sy, sz,
      ray.dx * c.throwSpeed + b.vx * c.inheritVelocity,
      ray.dy * c.throwSpeed + c.throwUp + b.vy * c.inheritVelocity * 0.5,
      ray.dz * c.throwSpeed + b.vz * c.inheritVelocity,
    )
  }

  /** Create a live grenade owned by `p` (also used directly by tests). */
  launchGrenade(p: SimPlayer, kindIndex: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const g: SimGrenade = { id: this.nextId++, kind: kindIndex, owner: p.id, team: p.team, age: 0, phase: 0, timer: 0, resting: false, x, y, z, vx, vy, vz }
    const kind = GRENADE_KINDS[kindIndex]
    if (kind === 'frag') g.timer = (GRENADES.frag as FragDef).fuse
    else if (kind === 'gas') g.timer = (GRENADES.gas as GasDef).fuse
    else g.timer = (GRENADES.prox as ProxDef).armDelay
    this.grenades.push(g)
    this.events.push({ ev: 'throw', p: p.id, k: kindIndex, id: g.id })
  }

  private stepGrenades(dt: number): void {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i]
      g.age += dt
      const kind: GrenadeKind = GRENADE_KINDS[g.kind]
      const step = stepGrenade(g, dt, this.world)
      this.clampGrenade(g)
      let done = false
      if (kind === 'frag') {
        g.timer -= dt
        if (g.timer <= 0) { this.blast(g, GRENADES.frag as FragDef); done = true }
      } else if (kind === 'gas') {
        const def = GRENADES.gas as GasDef
        if (g.phase === 0 && step.hitGround && def.burstOnLanding) { g.phase = 1; g.timer = Math.min(g.timer, def.landingDelay) }
        g.timer -= dt
        if (g.timer <= 0) { this.spawnCloud(g, def); done = true }
      } else {
        const def = GRENADES.prox as ProxDef
        if (g.phase === 0 && step.hitSurface) {
          // Sticks where it lands, then the arm timer starts.
          g.phase = 1
          g.timer = def.armDelay
          g.vx = g.vy = g.vz = 0
          g.resting = true
        } else if (g.phase === 1) {
          g.timer -= dt
          if (g.timer <= 0) { g.phase = 2; this.events.push({ ev: 'armed', id: g.id }) }
        } else if (g.phase === 2) {
          if (this.proxTriggered(g, def)) { g.phase = 3; g.timer = def.blastDelay }
        } else if (g.phase === 3) {
          g.timer -= dt
          if (g.timer <= 0) { this.blast(g, def); done = true }
        }
        if (!done && g.age >= def.maxLife) { this.blast(g, def); done = true }
      }
      if (!done && g.y < this.bounds.killY - 6) done = true // fell out of the world: fizzles
      if (done) this.grenades.splice(i, 1)
    }
  }

  private clampGrenade(g: SimGrenade): void {
    const bx = this.bounds.x - 0.2
    const bz = this.bounds.z - 0.2
    if (g.x > bx) { g.x = bx; g.vx = -Math.abs(g.vx) * 0.4 } else if (g.x < -bx) { g.x = -bx; g.vx = Math.abs(g.vx) * 0.4 }
    if (g.z > bz) { g.z = bz; g.vz = -Math.abs(g.vz) * 0.4 } else if (g.z < -bz) { g.z = -bz; g.vz = Math.abs(g.vz) * 0.4 }
    if (g.y > this.bounds.ceiling) { g.y = this.bounds.ceiling; g.vy = -Math.abs(g.vy) * 0.4 }
  }

  private proxTriggered(g: SimGrenade, def: ProxDef): boolean {
    for (const o of this.players.values()) {
      if (o.dead || o.team === g.team || o.protectLeft > 0) continue
      const [tx, ty, tz] = torsoPoint(o.state.body.x, o.state.body.y, o.state.body.z)
      if (Math.hypot(tx - g.x, ty - g.y, tz - g.z) <= def.triggerRadius && !this.blocked(g.x, g.y + 0.1, g.z, tx, ty, tz)) return true
    }
    for (const d of this.dummies) {
      if (!d.alive) continue
      const [tx, ty, tz] = torsoPoint(d.spec.x, d.spec.y, d.spec.z)
      if (Math.hypot(tx - g.x, ty - g.y, tz - g.z) <= def.triggerRadius && !this.blocked(g.x, g.y + 0.1, g.z, tx, ty, tz)) return true
    }
    return false
  }

  /** True when solid geometry lies between the two points. */
  private blocked(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const len = Math.hypot(dx, dy, dz)
    if (len < 0.05) return false
    return !!this.world.raycast(ax, ay, az, dx / len, dy / len, dz / len, len - 0.05)
  }

  private blast(g: SimGrenade, def: FragDef | ProxDef): void {
    this.events.push({ ev: 'boom', k: g.kind, x: r2(g.x), y: r2(g.y), z: r2(g.z), r: def.radius })
    const owner = this.players.get(g.owner) ?? null
    for (const o of this.players.values()) {
      if (o.dead) continue
      const [tx, ty, tz] = torsoPoint(o.state.body.x, o.state.body.y, o.state.body.z)
      const dist = Math.hypot(tx - g.x, ty - g.y, tz - g.z)
      if (dist >= def.radius || this.blocked(g.x, g.y + 0.1, g.z, tx, ty, tz)) continue
      const self = o.id === g.owner
      if (!self && o.team === g.team) continue
      this.damage(o.id, blastDamage(def, dist) * (self ? GRENADE_COMMON.selfDamageMult : 1), owner ?? o, def.id, false)
    }
    for (const d of this.dummies) {
      if (!d.alive) continue
      const [tx, ty, tz] = torsoPoint(d.spec.x, d.spec.y, d.spec.z)
      const dist = Math.hypot(tx - g.x, ty - g.y, tz - g.z)
      if (dist >= def.radius || this.blocked(g.x, g.y + 0.1, g.z, tx, ty, tz)) continue
      this.damage(`dummy:${d.spec.id}`, blastDamage(def, dist), owner, def.id, false)
    }
  }

  private spawnCloud(g: SimGrenade, def: GasDef): void {
    const cloud: SimGas = { id: this.nextId++, owner: g.owner, team: g.team, x: g.x, y: g.y + 0.2, z: g.z, r: def.cloudRadius, left: def.cloudDuration, tickLeft: def.tickSeconds, def }
    this.clouds.push(cloud)
    this.events.push({ ev: 'gas', id: cloud.id, x: r2(cloud.x), y: r2(cloud.y), z: r2(cloud.z), r: cloud.r, dur: def.cloudDuration })
  }

  private stepClouds(dt: number): void {
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i]
      c.left -= dt
      c.tickLeft -= dt
      if (c.tickLeft <= 0) {
        c.tickLeft += c.def.tickSeconds
        const owner = this.players.get(c.owner) ?? null
        for (const o of this.players.values()) {
          if (o.dead) continue
          const [tx, ty, tz] = torsoPoint(o.state.body.x, o.state.body.y, o.state.body.z)
          if (Math.hypot(tx - c.x, tz - c.z) > c.r || ty < c.y - 1.2 || ty > c.y + c.def.maxCloudHeight) continue
          if (this.blocked(c.x, c.y + 0.3, c.z, tx, ty, tz)) continue
          const self = o.id === c.owner
          if (!self && o.team === c.team) continue
          this.damage(o.id, c.def.damagePerTick * (self ? GRENADE_COMMON.selfDamageMult : 1), owner ?? o, 'gas', false)
        }
        for (const d of this.dummies) {
          if (!d.alive) continue
          const [tx, ty, tz] = torsoPoint(d.spec.x, d.spec.y, d.spec.z)
          if (Math.hypot(tx - c.x, tz - c.z) > c.r || ty < c.y - 1.2 || ty > c.y + c.def.maxCloudHeight) continue
          this.damage(`dummy:${d.spec.id}`, c.def.damagePerTick, owner, 'gas', false)
        }
      }
      if (c.left <= 0) this.clouds.splice(i, 1)
    }
  }

  // ---- pickups -------------------------------------------------------------------------------
  private rollWeapon(spotIndex: number): string | null {
    const tier = ARENA.pickups[spotIndex].tier
    const held = new Set(this.pickups.map(p => p.weapon).filter(Boolean) as string[])
    let pool = pickupData.pool.filter(e => e.tiers.includes(tier) && findWeapon(e.weapon))
    const fresh = pool.filter(e => !held.has(e.weapon))
    if (fresh.length) pool = fresh
    const total = pool.reduce((s, e) => s + e.weight, 0)
    if (total <= 0) return null
    let roll = this.rng() * total
    for (const e of pool) { roll -= e.weight; if (roll <= 0) return e.weapon }
    return pool[pool.length - 1].weapon
  }

  private stepPickups(dt: number): void {
    const radius = pickupData.pickupRadius
    this.pickups.forEach((spot, i) => {
      const pos = ARENA.pickups[i]
      if (spot.weapon === null) {
        spot.timer -= dt
        if (spot.timer <= 0) {
          spot.weapon = this.rollWeapon(i)
          spot.age = 0
          if (spot.weapon) this.events.push({ ev: 'item', spot: i, w: spot.weapon })
          else spot.timer = 5
        }
        return
      }
      spot.age += dt
      // Exactly one claimant per spot per tick: the nearest eligible player (ties: join order).
      let best: SimPlayer | null = null
      let bestD = radius
      const def = weaponById(spot.weapon)
      for (const p of this.players.values()) {
        if (p.dead || this.phase !== 'live') continue
        const [tx, ty, tz] = torsoPoint(p.state.body.x, p.state.body.y, p.state.body.z)
        const d = Math.hypot(tx - pos.x, ty - 0.1 - pos.y, tz - pos.z)
        if (d >= bestD) continue
        const slot = p.state.loadout.slots[def.slot === 'primary' ? 0 : 1]
        if (slot.def.id === def.id && slot.ammo >= def.clip) continue
        best = p
        bestD = d
      }
      if (best) {
        best.state.loadout.equip(def)
        this.events.push({ ev: 'pickup', p: best.id, spot: i, w: spot.weapon })
        spot.weapon = null
        spot.timer = pickupData.respawnSeconds + this.rng() * pickupData.respawnJitter
      } else if (spot.age >= pickupData.despawnSeconds) {
        // Uncollected too long: remove it so the next roll can pick something different.
        spot.weapon = null
        spot.timer = 2
      }
    })
  }

  private stepDummies(dt: number): void {
    for (const d of this.dummies) {
      if (d.alive) continue
      d.respawnLeft -= dt
      if (d.respawnLeft <= 0) { d.alive = true; d.hp = d.spec.hp }
    }
  }

  // ---- match flow ----------------------------------------------------------------------------
  private setPhase(ph: MatchPhase, winner?: number): void {
    this.phase = ph
    this.events.push({ ev: 'phase', ph, winner })
  }

  endMatch(): void {
    if (this.phase === 'results') return
    this.winner = this.scores[0] === this.scores[1] ? -1 : this.scores[0] > this.scores[1] ? 0 : 1
    this.resultsLeft = matchData.resultsSeconds
    this.grenades.length = 0
    this.clouds.length = 0
    this.setPhase('results', this.winner)
  }

  // ---- snapshots -----------------------------------------------------------------------------
  drainEvents(): NetEvent[] {
    const out = this.events
    this.events = []
    return out
  }

  playerSnap(p: SimPlayer): PlayerSnap {
    const b = p.state.body
    return {
      i: p.id, x: r2(b.x), y: r2(b.y), z: r2(b.z), yw: Math.round(p.yaw * 1000) / 1000, pt: Math.round(p.pitch * 1000) / 1000,
      hp: Math.ceil(p.health), d: p.dead ? 1 : 0, w: p.state.loadout.weapon.def.id, th: p.state.jet.thrusting ? 1 : 0,
      gr: p.state.grounded ? 1 : 0, k: p.kills, de: p.deaths, em: p.emoteLeft > 0 ? 1 : 0, pr: p.protectLeft > 0 ? 1 : 0, t: p.team,
    }
  }

  shared(): SnapshotShared {
    return {
      t: this.tick, ms: Math.round(this.time * 1000), ph: this.phase, tl: Math.max(0, Math.round(this.timeLeft)), sc: [...this.scores], kl: this.killLimit,
      p: [...this.players.values()].map(p => this.playerSnap(p)),
      g: this.grenades.map(g => ({ i: g.id, k: g.kind, x: r2(g.x), y: r2(g.y), z: r2(g.z), s: g.phase, f: r2(Math.max(0, g.timer)), o: g.owner, tm: g.team })),
      gas: this.clouds.map(c => ({ i: c.id, x: r2(c.x), y: r2(c.y), z: r2(c.z), r: c.r, l: r2(c.left), tm: c.team })),
      pk: this.pickups.map(p => p.weapon ?? ''),
      d: this.dummies.map(d => ({ i: d.spec.id, hp: Math.ceil(d.hp), a: d.alive ? 1 : 0 })),
      ev: [],
    }
  }

  you(id: string): YouState | null {
    const p = this.players.get(id)
    if (!p) return null
    const s = p.state
    const b = s.body
    return {
      x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz,
      jet: { fuel: s.jet.fuel, idle: s.jet.idle, hold: s.jet.hold, locked: s.jet.locked, thrusting: s.jet.thrusting },
      gr: s.grounded, air: s.airTime, coy: s.coyote,
      lo: s.loadout.toState(), gs: s.gren.toState(),
      hp: Math.ceil(p.health), dead: p.dead, rs: Math.max(0, p.respawnLeft), pr: p.protectLeft,
    }
  }
}

/** Rebuild a PlayerState from a server `you` payload (used for client reconciliation). */
export function applyYou(state: PlayerState, y: YouState): void {
  Object.assign(state.body, { x: y.x, y: y.y, z: y.z, vx: y.vx, vy: y.vy, vz: y.vz })
  Object.assign(state.jet, y.jet)
  state.grounded = y.gr
  state.airTime = y.air
  state.coyote = y.coy
  state.loadout.loadState(y.lo)
  state.gren.loadState(y.gs)
}


