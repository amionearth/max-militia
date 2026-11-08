/**
 * All gameplay tuning in one place. Weapon stats live in data/weapons.json and the map in
 * data/outpost.json; everything about movement, the jetpack and the camera lives here.
 */
export const DEFAULT_CONFIG = {
  player: {
    /** Half width of the collision box (metres). */
    radius: 0.35,
    height: 1.8,
    walkSpeed: 7,
    sprintSpeed: 11,
    acceleration: 55,
    /** Fraction of ground acceleration available in the air. */
    airControl: 0.6,
    jumpSpeed: 9.5,
    gravity: -26,
    maxFall: -38,
    coyoteTime: 0.1,
    maxHealth: 100,
    respawnSeconds: 3,
  },
  jetpack: {
    maxFuel: 100,
    drainPerSecond: 35,
    regenPerSecond: 22,
    groundRegenPerSecond: 45,
    regenDelay: 0.8,
    /** Upward acceleration at the very start of a thrust (the "burst"). */
    burstAccel: 56,
    /** Upward acceleration after holding for `burstSeconds`; a little below gravity so holding tapers off. */
    sustainAccel: 21,
    burstSeconds: 0.5,
    /** Seconds of burst regained per second with the button released (quick taps keep the burst). */
    burstRecover: 1,
    maxRiseSpeed: 11,
    /** Horizontal speed multiplier while thrusting. */
    airSpeedBoost: 1.15,
    /** Seconds in the air before Space switches from jump to thrust. */
    startDelay: 0.12,
  },
  camera: {
    distance: 4.6,
    shoulder: 0.85,
    height: 1.6,
    fov: 70,
    follow: 18,
    minPitch: -1.2,
    maxPitch: 1.25,
  },
} as const

// Gameplay always reads active values here. Source defaults stay immutable for Tweak Reset
// and Save with Manus; Apply never writes source or local storage.
type MutableConfig<T> = { -readonly [K in keyof T]: T[K] extends number ? number : T[K] extends object ? MutableConfig<T[K]> : T[K] }
export const CONFIG: MutableConfig<typeof DEFAULT_CONFIG> = structuredClone(DEFAULT_CONFIG)
