/**
 * Deterministic per-player simulation step, shared by the browser (prediction + practice mode) and
 * the authoritative server. Given the same state and the same input frame it always produces the
 * same result, which is what makes client-side prediction + server reconciliation work.
 *
 * It owns movement, jump, jetpack, weapon state (fire rate, ammo, reload, swap) and the grenade
 * stock. It does NOT resolve hits or spawn grenades: it reports `fired` / `throw` events and the
 * match simulation handles the consequences.
 */
import { CollisionWorld, type Body } from './collision'
import { CONFIG } from './config'
import { GrenadeStock } from './grenades'
import { createJet, stepJet, type JetState } from './jetpack'
import { Loadout } from './weapons'
import type { Bounds } from './arenaData'

export type InputFrame = {
  seq: number
  /** Strafe right (+1) / left (-1). */
  mx: number
  /** Forward (+1) / back (-1). */
  my: number
  sprint: boolean
  jumpHeld: boolean
  jumpPressed: boolean
  fireHeld: boolean
  firePressed: boolean
  reload: boolean
  /** -1 none, 0 primary, 1 secondary, 2 cycle. */
  slot: number
  throw: boolean
  /** -1 none, 0..2 select grenade type, 3 cycle. */
  gsel: number
  yaw: number
  pitch: number
  /** Client-reported view delay in ms (interpolation + latency), used for hit rewinding. */
  lag: number
  emote: boolean
}

export const NEUTRAL_INPUT: InputFrame = {
  seq: 0, mx: 0, my: 0, sprint: false, jumpHeld: false, jumpPressed: false, fireHeld: false, firePressed: false,
  reload: false, slot: -1, throw: false, gsel: -1, yaw: 0, pitch: 0, lag: 0, emote: false,
}

const finite = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Validates an untrusted input frame (from the network). Returns null if it is not a frame at all. */
export function sanitizeFrame(raw: unknown): InputFrame | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.seq !== 'number' || !Number.isInteger(r.seq) || r.seq < 0 || r.seq > 2_000_000_000) return null
  let mx = clamp(finite(r.mx), -1, 1)
  let my = clamp(finite(r.my), -1, 1)
  const len = Math.hypot(mx, my)
  if (len > 1) { mx /= len; my /= len }
  const slot = Math.trunc(finite(r.slot, -1))
  const gsel = Math.trunc(finite(r.gsel, -1))
  return {
    seq: r.seq,
    mx, my,
    sprint: r.sprint === true,
    jumpHeld: r.jumpHeld === true,
    jumpPressed: r.jumpPressed === true,
    fireHeld: r.fireHeld === true,
    firePressed: r.firePressed === true,
    reload: r.reload === true,
    slot: slot >= 0 && slot <= 2 ? slot : -1,
    throw: r.throw === true,
    gsel: gsel >= 0 && gsel <= 3 ? gsel : -1,
    yaw: clamp(finite(r.yaw), -1000, 1000),
    pitch: clamp(finite(r.pitch), CONFIG.camera.minPitch, CONFIG.camera.maxPitch),
    lag: clamp(finite(r.lag), 0, 250),
    emote: r.emote === true,
  }
}

export type SimEvent =
  | { type: 'jump' }
  | { type: 'land'; impact: number }
  | { type: 'fell' }
  | { type: 'fired'; weaponId: string; slot: number }
  | { type: 'dry' }
  | { type: 'reloadStart' }
  | { type: 'reloaded' }
  | { type: 'swap'; weaponId: string }
  | { type: 'throw'; kind: number }
  | { type: 'gsel'; kind: number }

export class PlayerState {
  readonly body: Body = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }
  readonly jet: JetState = createJet(CONFIG.jetpack.maxFuel)
  readonly loadout = new Loadout()
  readonly gren = new GrenadeStock()
  grounded = false
  airTime = 0
  coyote = 0

  spawn(x: number, y: number, z: number): void {
    Object.assign(this.body, { x, y, z, vx: 0, vy: 0, vz: 0 })
    Object.assign(this.jet, createJet(CONFIG.jetpack.maxFuel))
    this.grounded = false
    this.airTime = 0
    this.coyote = 0
  }

  copyFrom(o: PlayerState): void {
    Object.assign(this.body, o.body)
    Object.assign(this.jet, o.jet)
    this.loadout.loadState(o.loadout.toState())
    this.gren.copyFrom(o.gren)
    this.grounded = o.grounded
    this.airTime = o.airTime
    this.coyote = o.coyote
  }

  clone(): PlayerState {
    const c = new PlayerState()
    c.copyFrom(this)
    return c
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.body.vx, this.body.vz)
  }
}

export type SimContext = { world: CollisionWorld; bounds: Bounds }

/** Advance one fixed step. Events are appended to `events` (cosmetic on the client, authoritative on the server). */
export function stepPlayer(s: PlayerState, input: InputFrame, dt: number, ctx: SimContext, events: SimEvent[]): void {
  const c = CONFIG.player
  const j = CONFIG.jetpack
  const b = s.body

  // Weapons and grenades first (they never depend on this step's movement).
  if (s.loadout.update(dt) === 'reloaded') events.push({ type: 'reloaded' })
  s.gren.update(dt)
  if (input.slot === 0 || input.slot === 1) {
    if (s.loadout.select(input.slot)) events.push({ type: 'swap', weaponId: s.loadout.weapon.def.id })
  } else if (input.slot === 2) {
    if (s.loadout.cycle(1)) events.push({ type: 'swap', weaponId: s.loadout.weapon.def.id })
  }
  if (input.gsel >= 0) {
    const next = input.gsel === 3 ? (s.gren.selected + 1) % 3 : input.gsel
    if (s.gren.select(next)) events.push({ type: 'gsel', kind: next })
  }
  if (input.reload && s.loadout.startReload()) events.push({ type: 'reloadStart' })
  const fire = s.loadout.fire(input.firePressed, input.fireHeld)
  if (fire === 'fired') events.push({ type: 'fired', weaponId: s.loadout.weapon.def.id, slot: s.loadout.current })
  else if (fire === 'empty') {
    if (s.loadout.startReload()) events.push({ type: 'reloadStart' })
    else if (input.firePressed) events.push({ type: 'dry' })
  }
  if (input.throw) {
    const kind = s.gren.tryThrow()
    if (kind >= 0) events.push({ type: 'throw', kind })
  }

  // Horizontal movement relative to the view heading.
  const yaw = input.yaw
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  const rx = Math.cos(yaw)
  const rz = -Math.sin(yaw)
  let wx = fx * input.my + rx * input.mx
  let wz = fz * input.my + rz * input.mx
  const len = Math.hypot(wx, wz)
  if (len > 1) { wx /= len; wz /= len }
  const speed = (input.sprint ? c.sprintSpeed : c.walkSpeed) * (s.jet.thrusting ? j.airSpeedBoost : 1)
  const dvx = wx * speed - b.vx
  const dvz = wz * speed - b.vz
  const dv = Math.hypot(dvx, dvz)
  const maxDv = c.acceleration * (s.grounded ? 1 : c.airControl) * dt
  if (dv <= maxDv || dv === 0) { b.vx = wx * speed; b.vz = wz * speed }
  else { b.vx += (dvx / dv) * maxDv; b.vz += (dvz / dv) * maxDv }

  // Jump (with a little coyote time) and jetpack.
  s.coyote = s.grounded ? c.coyoteTime : Math.max(0, s.coyote - dt)
  s.airTime = s.grounded ? 0 : s.airTime + dt
  if (input.jumpPressed && s.coyote > 0) {
    b.vy = c.jumpSpeed
    s.coyote = 0
    s.grounded = false
    s.airTime = 0
    events.push({ type: 'jump' })
  }
  const wantThrust = input.jumpHeld && !s.grounded && s.airTime >= j.startDelay
  const thrust = stepJet(s.jet, wantThrust, s.grounded, dt, j)
  b.vy += (c.gravity + thrust) * dt
  if (s.jet.thrusting && b.vy > j.maxRiseSpeed) b.vy = j.maxRiseSpeed
  if (b.vy < c.maxFall) b.vy = c.maxFall

  const wasGrounded = s.grounded
  const result = ctx.world.moveBody(b, c.radius, c.height, dt)
  s.grounded = result.grounded
  if (result.grounded && !wasGrounded && result.impact > 6) events.push({ type: 'land', impact: result.impact })

  // Invisible walls and ceiling.
  const limX = ctx.bounds.x - c.radius
  const limZ = ctx.bounds.z - c.radius
  if (b.x > limX) { b.x = limX; b.vx = Math.min(b.vx, 0) }
  if (b.x < -limX) { b.x = -limX; b.vx = Math.max(b.vx, 0) }
  if (b.z > limZ) { b.z = limZ; b.vz = Math.min(b.vz, 0) }
  if (b.z < -limZ) { b.z = -limZ; b.vz = Math.max(b.vz, 0) }
  if (b.y + c.height > ctx.bounds.ceiling) { b.y = ctx.bounds.ceiling - c.height; b.vy = Math.min(b.vy, 0) }
  if (b.y < ctx.bounds.killY) events.push({ type: 'fell' })
}
