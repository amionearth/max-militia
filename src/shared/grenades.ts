/**
 * Grenade definitions (data/grenades.json) and the projectile physics step. Pure: used by the
 * authoritative simulation (browser practice mode and Node server) and unit tests.
 * Exactly three types exist: frag, gas and timed proximity.
 */
import data from '../data/grenades.json'
import type { Body, CollisionWorld } from './collision'

export type GrenadeKind = 'frag' | 'gas' | 'prox'
export const GRENADE_KINDS: GrenadeKind[] = ['frag', 'gas', 'prox']

export type FragDef = { id: 'frag'; name: string; key: string; fuse: number; radius: number; damage: number; minDamage: number; startCount: number; maxCount: number; rechargeSeconds: number; color: string }
export type GasDef = { id: 'gas'; name: string; key: string; fuse: number; burstOnLanding: boolean; landingDelay: number; cloudRadius: number; cloudDuration: number; tickSeconds: number; damagePerTick: number; maxCloudHeight: number; startCount: number; maxCount: number; rechargeSeconds: number; color: string }
export type ProxDef = { id: 'prox'; name: string; key: string; armDelay: number; triggerRadius: number; blastDelay: number; maxLife: number; radius: number; damage: number; minDamage: number; startCount: number; maxCount: number; rechargeSeconds: number; color: string }
export type GrenadeDef = FragDef | GasDef | ProxDef

export const GRENADE_COMMON = data.common
export const GRENADES: Record<GrenadeKind, GrenadeDef> = {
  frag: data.types.find(t => t.id === 'frag') as FragDef,
  gas: data.types.find(t => t.id === 'gas') as GasDef,
  prox: data.types.find(t => t.id === 'prox') as ProxDef,
}

export function grenadeKindAt(index: number): GrenadeKind {
  return GRENADE_KINDS[((index % 3) + 3) % 3]
}

/** Per-player grenade stock, part of the deterministic player state. */
export class GrenadeStock {
  count: number[] = GRENADE_KINDS.map(k => GRENADES[k].startCount)
  /** Seconds until the next recharge of each type (only ticks while below max). */
  timer: number[] = GRENADE_KINDS.map(k => GRENADES[k].rechargeSeconds)
  selected = 0
  /** Seconds until another throw is allowed. */
  cooldown = 0

  update(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt)
    GRENADE_KINDS.forEach((kind, i) => {
      const def = GRENADES[kind]
      if (this.count[i] >= def.maxCount) { this.timer[i] = def.rechargeSeconds; return }
      this.timer[i] -= dt
      if (this.timer[i] <= 0) {
        this.count[i] += 1
        this.timer[i] = def.rechargeSeconds
      }
    })
  }

  /** Try to throw the selected type. Returns its index, or -1 when none is available. */
  tryThrow(): number {
    if (this.cooldown > 0 || this.count[this.selected] <= 0) return -1
    const kind = GRENADE_KINDS[this.selected]
    const def = GRENADES[kind]
    if (this.count[this.selected] >= def.maxCount) this.timer[this.selected] = def.rechargeSeconds
    this.count[this.selected] -= 1
    this.cooldown = GRENADE_COMMON.throwCooldown
    return this.selected
  }

  select(index: number): boolean {
    if (index < 0 || index > 2 || index === this.selected) return false
    this.selected = index
    return true
  }

  reset(): void {
    this.count = GRENADE_KINDS.map(k => GRENADES[k].startCount)
    this.timer = GRENADE_KINDS.map(k => GRENADES[k].rechargeSeconds)
    this.cooldown = 0
  }

  copyFrom(o: GrenadeStock): void {
    this.count = [...o.count]
    this.timer = [...o.timer]
    this.selected = o.selected
    this.cooldown = o.cooldown
  }

  toState(): GrenadeStockState {
    return { count: [...this.count], timer: this.timer.map(t => Math.round(t * 100) / 100), selected: this.selected, cooldown: Math.round(this.cooldown * 100) / 100 }
  }

  loadState(s: GrenadeStockState): void {
    this.count = GRENADE_KINDS.map((k, i) => Math.max(0, Math.min(GRENADES[k].maxCount, Math.floor(s.count[i] ?? 0))))
    this.timer = GRENADE_KINDS.map((k, i) => s.timer[i] ?? GRENADES[k].rechargeSeconds)
    this.selected = s.selected >= 0 && s.selected <= 2 ? s.selected : 0
    this.cooldown = s.cooldown ?? 0
  }
}

export type GrenadeStockState = { count: number[]; timer: number[]; selected: number; cooldown: number }

/** Linear falloff from `damage` at the centre to `minDamage` at the radius edge. */
export function blastDamage(def: FragDef | ProxDef, distance: number): number {
  if (distance >= def.radius) return 0
  const k = 1 - distance / def.radius
  return def.minDamage + (def.damage - def.minDamage) * k
}

export type GrenadeBody = { x: number; y: number; z: number; vx: number; vy: number; vz: number; resting: boolean }

/** Result of one physics step. `hitSurface` is the first contact this step (for gas landing / prox sticking). */
export type GrenadeStep = { hitSurface: boolean; hitGround: boolean }

/**
 * Advances a grenade: gravity, AABB collision with bounce and ground friction. The grenade's
 * (x,y,z) is its centre; internally it uses a small box body so it reuses the player collision.
 */
export function stepGrenade(g: GrenadeBody, dt: number, world: CollisionWorld): GrenadeStep {
  const r = GRENADE_COMMON.radius
  const out: GrenadeStep = { hitSurface: false, hitGround: false }
  if (g.resting) return out
  g.vy += GRENADE_COMMON.gravity * dt
  const body: Body = { x: g.x, y: g.y - r, z: g.z, vx: g.vx, vy: g.vy, vz: g.vz }
  const before = { vx: g.vx, vy: g.vy, vz: g.vz }
  const res = world.moveBody(body, r, r * 2, dt)
  const e = GRENADE_COMMON.bounce
  // moveBody zeroes the velocity component it collided on: reflect it with energy loss instead.
  if (body.vx === 0 && before.vx !== 0) { body.vx = -before.vx * e; out.hitSurface = true }
  if (body.vz === 0 && before.vz !== 0) { body.vz = -before.vz * e; out.hitSurface = true }
  if (body.vy === 0 && before.vy !== 0) {
    out.hitSurface = true
    if (before.vy < 0) {
      out.hitGround = true
      if (-before.vy > 2.2) {
        // A real bounce: lose energy and some sideways speed.
        body.vy = -before.vy * e
        body.vx *= GRENADE_COMMON.friction
        body.vz *= GRENADE_COMMON.friction
      } else {
        // Rolling: gentle time-based damping, no re-bounce.
        body.vy = 0
        const damp = Math.max(0, 1 - 4 * dt)
        body.vx *= damp
        body.vz *= damp
      }
    } else body.vy = -before.vy * e
  }
  g.x = body.x
  g.y = body.y + r
  g.z = body.z
  g.vx = body.vx
  g.vy = body.vy
  g.vz = body.vz
  if (res.grounded && Math.abs(g.vy) < 0.01 && Math.hypot(g.vx, g.vz) < 0.35) {
    g.vx = g.vy = g.vz = 0
    g.resting = true
  }
  return out
}
