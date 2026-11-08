/**
 * Weapon definitions (loaded from data/weapons.json) and the pure loadout state machine:
 * fire rate, clip, reload, weapon swapping and pickup equipping. No rendering here, so it is shared
 * by the browser, the unit tests and the authoritative Node server.
 */
import weaponData from '../data/weapons.json'

export type WeaponDef = {
  id: string
  name: string
  slot: 'primary' | 'secondary'
  auto: boolean
  damage: number
  headshotMult: number
  pellets: number
  /** Damage multiplier reached at max range (linear). 1 = no falloff. */
  falloff: number
  fireRate: number
  clip: number
  reload: number
  swapTime: number
  range: number
  spread: number
  spreadMove: number
  spreadAir: number
  shake: number
  tracer: string
  sound: string
}

export const WEAPONS: WeaponDef[] = weaponData.weapons as WeaponDef[]

export function findWeapon(id: string): WeaponDef | undefined {
  return WEAPONS.find(w => w.id === id)
}

export function weaponById(id: string): WeaponDef {
  const def = findWeapon(id)
  if (!def) throw new Error(`Unknown weapon: ${id}`)
  return def
}

export const STARTER_PRIMARY = 'uzi'
export const STARTER_SECONDARY = 'deagle'

export type WeaponSlotState = { def: WeaponDef; ammo: number }
export type FireResult = 'fired' | 'empty' | 'blocked' | 'idle'

/** Plain-data form of a loadout (sent to the owning client in snapshots). */
export type LoadoutState = {
  ids: [string, string]
  ammo: [number, number]
  current: number
  cooldown: number
  reloadLeft: number
  swapLeft: number
}

export class Loadout {
  readonly slots: WeaponSlotState[]
  current = 0
  /** Seconds until the next shot is allowed. */
  cooldown = 0
  /** Remaining reload time; 0 when not reloading. */
  reloadLeft = 0
  /** Remaining swap time; 0 when ready. */
  swapLeft = 0

  constructor(primary: WeaponDef = weaponById(STARTER_PRIMARY), secondary: WeaponDef = weaponById(STARTER_SECONDARY)) {
    this.slots = [primary, secondary].map(def => ({ def, ammo: def.clip }))
  }

  get weapon(): WeaponSlotState {
    return this.slots[this.current]
  }

  get reloading(): boolean {
    return this.reloadLeft > 0
  }

  update(dt: number): 'reloaded' | null {
    // The cooldown may go slightly negative: the remainder carries into the next shot so the
    // effective fire rate is not quantized to the 60 Hz simulation step.
    this.cooldown = Math.max(-dt, this.cooldown - dt)
    this.swapLeft = Math.max(0, this.swapLeft - dt)
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt
      if (this.reloadLeft <= 0) {
        this.reloadLeft = 0
        this.weapon.ammo = this.weapon.def.clip
        return 'reloaded'
      }
    }
    return null
  }

  /** `pressed` is the trigger edge this step, `held` is the trigger state. */
  fire(pressed: boolean, held: boolean): FireResult {
    const w = this.weapon
    const wants = w.def.auto ? held : pressed
    if (!wants) return 'idle'
    if (this.reloading || this.swapLeft > 0 || this.cooldown > 0) return 'blocked'
    if (w.ammo <= 0) return 'empty'
    w.ammo -= 1
    this.cooldown += 1 / w.def.fireRate
    return 'fired'
  }

  startReload(): boolean {
    const w = this.weapon
    if (this.reloading || this.swapLeft > 0 || w.ammo >= w.def.clip) return false
    this.reloadLeft = w.def.reload
    return true
  }

  select(index: number): boolean {
    if (index === this.current || index < 0 || index >= this.slots.length) return false
    this.current = index
    this.reloadLeft = 0
    this.cooldown = 0
    this.swapLeft = this.weapon.def.swapTime
    return true
  }

  cycle(direction: number): boolean {
    const n = this.slots.length
    return this.select((this.current + (direction >= 0 ? 1 : -1) + n) % n)
  }

  /** Pickup: replaces the weapon in the matching slot with a full clip and selects it. */
  equip(def: WeaponDef): void {
    const index = def.slot === 'primary' ? 0 : 1
    this.slots[index] = { def, ammo: def.clip }
    this.current = index
    this.reloadLeft = 0
    this.cooldown = 0
    this.swapLeft = def.swapTime
  }

  /** Respawn keeps the chosen loadout but refills ammo. */
  refill(): void {
    for (const s of this.slots) s.ammo = s.def.clip
    this.reloadLeft = 0
    this.cooldown = 0
    this.swapLeft = 0
  }

  /** Back to the starter pair with full ammo (new match / pickup weapons are dropped on death). */
  resetToStarters(): void {
    const a = weaponById(STARTER_PRIMARY)
    const b = weaponById(STARTER_SECONDARY)
    this.slots[0] = { def: a, ammo: a.clip }
    this.slots[1] = { def: b, ammo: b.clip }
    this.current = 0
    this.reloadLeft = 0
    this.cooldown = 0
    this.swapLeft = 0
  }

  toState(): LoadoutState {
    return {
      ids: [this.slots[0].def.id, this.slots[1].def.id],
      ammo: [this.slots[0].ammo, this.slots[1].ammo],
      current: this.current,
      cooldown: this.cooldown,
      reloadLeft: this.reloadLeft,
      swapLeft: this.swapLeft,
    }
  }

  /** Overwrite from a (trusted, server-sent) state. Unknown ids fall back to the starters. */
  loadState(s: LoadoutState): void {
    const fallback = [weaponById(STARTER_PRIMARY), weaponById(STARTER_SECONDARY)]
    for (let i = 0; i < 2; i++) {
      const def = findWeapon(s.ids[i]) ?? fallback[i]
      this.slots[i] = { def, ammo: Math.max(0, Math.min(def.clip, Math.floor(s.ammo[i] ?? def.clip))) }
    }
    this.current = s.current === 1 ? 1 : 0
    this.cooldown = s.cooldown
    this.reloadLeft = s.reloadLeft
    this.swapLeft = s.swapLeft
  }

  clone(): Loadout {
    const copy = new Loadout()
    copy.loadState(this.toState())
    return copy
  }
}

/** Damage after distance falloff for one pellet/bullet that travelled `distance` metres. */
export function damageAt(def: WeaponDef, distance: number): number {
  const k = Math.min(1, Math.max(0, distance / def.range))
  return def.damage * (1 + (def.falloff - 1) * k)
}
