/**
 * Jetpack rules (pure, unit tested). Fuel drains while thrusting and regenerates after a short
 * delay. Thrust is strongest at the start of a press and settles to a weaker sustained level, so
 * short bursts are more fuel-efficient than holding the button.
 */
export type JetConfig = {
  maxFuel: number
  drainPerSecond: number
  regenPerSecond: number
  groundRegenPerSecond: number
  regenDelay: number
  burstAccel: number
  sustainAccel: number
  burstSeconds: number
  /** How fast the burst "refreshes" per second of released button (seconds of hold regained). */
  burstRecover: number
}

export type JetState = {
  fuel: number
  /** Seconds since thrust last stopped (drives the regeneration delay). */
  idle: number
  /** Seconds of "warm" thrust; falls back gradually when released so quick taps keep the burst. */
  hold: number
  /** True when the tank hit zero; thrust stays off until the button is released. */
  locked: boolean
  thrusting: boolean
}

export function createJet(maxFuel: number): JetState {
  return { fuel: maxFuel, idle: 99, hold: 0, locked: false, thrusting: false }
}

/** Advances the jetpack by `dt` and returns the upward acceleration to add (0 when off). */
export function stepJet(s: JetState, want: boolean, onGround: boolean, dt: number, cfg: JetConfig): number {
  if (!want) s.locked = false
  const canThrust = want && !s.locked && s.fuel > 0
  if (canThrust) {
    s.thrusting = true
    s.hold += dt
    s.idle = 0
    s.fuel = Math.max(0, s.fuel - cfg.drainPerSecond * dt)
    if (s.fuel <= 0) s.locked = true
    const settle = Math.max(0, 1 - s.hold / cfg.burstSeconds)
    return cfg.sustainAccel + (cfg.burstAccel - cfg.sustainAccel) * settle
  }
  s.thrusting = false
  s.hold = Math.max(0, s.hold - cfg.burstRecover * dt)
  s.idle += dt
  // While locked (ran dry and still holding the button) the tank stays empty until release.
  if (s.idle >= cfg.regenDelay && !s.locked) {
    const rate = onGround ? cfg.groundRegenPerSecond : cfg.regenPerSecond
    s.fuel = Math.min(cfg.maxFuel, s.fuel + rate * dt)
  }
  return 0
}
