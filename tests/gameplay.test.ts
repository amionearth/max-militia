import { afterEach, describe, expect, it } from 'vitest'
import outpost from '../src/data/outpost.json'
import { boxFromCenter, CollisionWorld, type Body } from '../src/game/collision'
import { CONFIG, DEFAULT_CONFIG } from '../src/game/config'
import { createJet, stepJet } from '../src/game/jetpack'
import { Player, type Intent, type PlayerEvent } from '../src/game/player'
import { tuning } from '../src/game/tuning'
import { Loadout, WEAPONS, weaponById } from '../src/game/weapons'

const floor = () => new CollisionWorld([boxFromCenter('floor', [0, -1, 0], [40, 2, 40]), boxFromCenter('wall', [5, 2, 0], [1, 4, 10])])
const body = (): Body => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })

describe('collision', () => {
  it('lands on a surface and reports ground contact', () => {
    const w = floor()
    const b = { ...body(), y: 2, vy: -10 }
    let grounded = false
    for (let i = 0; i < 60; i++) grounded = w.moveBody(b, 0.35, 1.8, 1 / 60).grounded || grounded
    expect(grounded).toBe(true)
    expect(b.y).toBeCloseTo(0, 3)
  })

  it('stops against walls and keeps standing grounded without jitter', () => {
    const w = floor()
    const b = { ...body(), vx: 8 }
    for (let i = 0; i < 90; i++) {
      b.vy -= 26 / 60
      b.vx = 8
      w.moveBody(b, 0.35, 1.8, 1 / 60)
    }
    expect(b.x).toBeLessThan(4.5 - 0.35 + 0.01)
    expect(b.y).toBeCloseTo(0, 3)
  })

  it('bumps the head on ceilings', () => {
    const w = new CollisionWorld([boxFromCenter('ceil', [0, 3, 0], [10, 1, 10])])
    const b = { ...body(), y: 0, vy: 20 }
    let hit = false
    for (let i = 0; i < 30; i++) hit = w.moveBody(b, 0.35, 1.8, 1 / 60).hitCeiling || hit
    expect(hit).toBe(true)
    expect(b.y + 1.8).toBeLessThanOrEqual(2.5 + 1e-3)
  })

  it('ray casts return the nearest hit with a face normal', () => {
    const w = floor()
    const hit = w.raycast(-5, 1, 0, 1, 0, 0, 100)!
    expect(hit.t).toBeCloseTo(9.5)
    expect(hit.nx).toBe(-1)
    expect(w.raycast(-5, 1, 0, -1, 0, 0, 100)).toBeNull()
    expect(w.raycast(0, 5, 0, 0, -1, 0, 3)).toBeNull()
  })
})

describe('jetpack', () => {
  const cfg = CONFIG.jetpack
  it('drains about 35 per second while thrusting and empties in under three seconds', () => {
    const s = createJet(100)
    for (let i = 0; i < 60; i++) stepJet(s, true, false, 1 / 60, cfg)
    expect(s.fuel).toBeCloseTo(100 - cfg.drainPerSecond, 0)
    for (let i = 0; i < 180; i++) stepJet(s, true, false, 1 / 60, cfg)
    expect(s.fuel).toBe(0)
    expect(s.locked).toBe(true)
    expect(stepJet(s, true, false, 1 / 60, cfg)).toBe(0)
  })

  it('waits 0.8 s before regenerating, then refills faster on the ground', () => {
    const air = createJet(100)
    const ground = createJet(100)
    air.fuel = ground.fuel = 20
    air.idle = ground.idle = 0
    for (let i = 0; i < 40; i++) { stepJet(air, false, false, 1 / 60, cfg); stepJet(ground, false, true, 1 / 60, cfg) }
    expect(air.fuel).toBe(20)
    for (let i = 0; i < 60; i++) { stepJet(air, false, false, 1 / 60, cfg); stepJet(ground, false, true, 1 / 60, cfg) }
    expect(air.fuel).toBeGreaterThan(20)
    expect(ground.fuel).toBeGreaterThan(air.fuel)
  })

  it('needs a released button after running dry before thrust returns', () => {
    const s = createJet(100)
    s.fuel = 0.1
    stepJet(s, true, false, 1 / 60, cfg)
    for (let i = 0; i < 120; i++) stepJet(s, true, false, 1 / 60, cfg)
    expect(s.thrusting).toBe(false)
    stepJet(s, false, false, 1 / 60, cfg)
    expect(s.locked).toBe(false)
  })

  it('makes short bursts more fuel efficient than holding', () => {
    const climb = (burstCount: number, burstLen: number) => {
      const s = createJet(100)
      let v = 0
      let y = 0
      for (let b = 0; b < burstCount; b++) {
        for (let i = 0; i < burstLen; i++) { const a = stepJet(s, true, false, 1 / 60, cfg); v += (CONFIG.player.gravity + a) / 60; y += v / 60 }
        for (let i = 0; i < 20; i++) { stepJet(s, false, false, 1 / 60, cfg); v += CONFIG.player.gravity / 60 }
      }
      return 100 - s.fuel
    }
    const burstAccel = (len: number) => { const s = createJet(100); let sum = 0; for (let i = 0; i < len; i++) sum += stepJet(s, true, false, 1 / 60, cfg); return sum / len }
    expect(burstAccel(12)).toBeGreaterThan(burstAccel(150))
    expect(climb(3, 12)).toBeGreaterThan(0)
  })
})

describe('weapons', () => {
  it('starts with the Uzi and the Desert Eagle (40 round Uzi clip)', () => {
    expect(WEAPONS.slice(0, 2).map(w => w.id)).toEqual(['uzi', 'deagle'])
    expect(weaponById('uzi')).toMatchObject({ clip: 40, auto: true })
    expect(weaponById('deagle').auto).toBe(false)
  })

  it('fires the Uzi automatically at its fire rate and the Eagle once per click', () => {
    const l = new Loadout()
    let shots = 0
    for (let i = 0; i < 60; i++) { l.update(1 / 60); if (l.fire(i === 0, true) === 'fired') shots++ }
    expect(shots).toBeGreaterThanOrEqual(13)
    expect(shots).toBeLessThanOrEqual(15)
    l.select(1)
    l.update(1)
    let eagle = 0
    for (let i = 0; i < 60; i++) { l.update(1 / 60); if (l.fire(false, true) === 'fired') eagle++ }
    expect(eagle).toBe(0)
    expect(l.fire(true, true)).toBe('fired')
  })

  it('reloads over time, blocks firing meanwhile and cancels on swap; respawn keeps loadout but refills', () => {
    const l = new Loadout()
    l.weapon.ammo = 3
    expect(l.startReload()).toBe(true)
    expect(l.fire(true, true)).toBe('blocked')
    let done = false
    for (let i = 0; i < 120 && !done; i++) done = l.update(1 / 60) === 'reloaded'
    expect(done).toBe(true)
    expect(l.weapon.ammo).toBe(40)
    l.weapon.ammo = 1
    l.startReload()
    l.select(1)
    expect(l.reloading).toBe(false)
    l.select(0)
    expect(l.weapon.ammo).toBe(1)
    l.select(1)
    l.refill()
    expect(l.current).toBe(1)
    expect(l.slots.every(s => s.ammo === s.def.clip)).toBe(true)
  })

  it('reports an empty clip', () => {
    const l = new Loadout()
    l.weapon.ammo = 0
    expect(l.fire(true, true)).toBe('empty')
  })
})

describe('player', () => {
  const world = floor()
  const bounds = { x: 20, z: 20, ceiling: 40, killY: -24 }
  const idle: Intent = { moveX: 0, moveY: 0, sprint: false, jumpPressed: false, jumpHeld: false }

  const settle = (p: Player) => { for (let i = 0; i < 30; i++) p.step(1 / 60, idle, 0, []) }

  it('jumps, then thrusts only after leaving the ground and burns fuel', () => {
    const p = new Player(world, bounds)
    p.spawn(0, 0, 0, 0)
    settle(p)
    expect(p.grounded).toBe(true)
    const events: PlayerEvent[] = []
    p.step(1 / 60, { ...idle, jumpPressed: true, jumpHeld: true }, 0, events)
    expect(events[0]).toEqual({ type: 'jump' })
    expect(p.jet.thrusting).toBe(false)
    for (let i = 0; i < 30; i++) p.step(1 / 60, { ...idle, jumpHeld: true }, 0, [])
    expect(p.jet.thrusting).toBe(true)
    expect(p.jet.fuel).toBeLessThan(100)
    expect(p.body.y).toBeGreaterThan(2)
  })

  it('moves relative to the camera and respects the invisible bounds', () => {
    const p = new Player(world, bounds)
    p.spawn(0, 0, 0, 0)
    settle(p)
    for (let i = 0; i < 240; i++) p.step(1 / 60, { ...idle, moveY: 1 }, 0, [])
    expect(p.body.z).toBeLessThan(-3)
    for (let i = 0; i < 600; i++) p.step(1 / 60, { ...idle, moveY: 1, moveX: 1 }, 0, [])
    expect(Math.abs(p.body.x)).toBeLessThanOrEqual(bounds.x)
    expect(Math.abs(p.body.z)).toBeLessThanOrEqual(bounds.z)
  })

  it('reports falling into the kill zone and keeps 100 HP without regeneration', () => {
    const open = new CollisionWorld([])
    const p = new Player(open, bounds)
    p.spawn(0, 0, 0, 0)
    const events: PlayerEvent[] = []
    for (let i = 0; i < 300 && !events.some(e => e.type === 'fell'); i++) p.step(1 / 60, idle, 0, events)
    expect(events.some(e => e.type === 'fell')).toBe(true)
    p.spawn(0, 0, 0, 0)
    expect(p.damage(60)).toBe(false)
    for (let i = 0; i < 600; i++) p.step(1 / 60, idle, 0, [])
    expect(p.health).toBe(40)
    expect(p.damage(60)).toBe(true)
    p.die()
    expect(p.respawnLeft).toBe(3)
  })
})

describe('Outpost map data', () => {
  const boxes = outpost.solids.map(s => boxFromCenter(s.id, s.pos, s.size))
  const world = new CollisionWorld(boxes)

  it('has unobstructed spawns standing on solid ground', () => {
    for (const s of outpost.spawns) {
      expect(world.isBlocked(s.pos[0], s.pos[1] + 0.01, s.pos[2], 0.35, 1.8)).toBe(false)
      expect(world.isBlocked(s.pos[0], s.pos[1] - 0.05, s.pos[2], 0.3, 0.02)).toBe(true)
    }
  })

  it('places every dummy on a surface and within the bounds', () => {
    for (const d of outpost.dummies) {
      expect(world.isBlocked(d.pos[0], d.pos[1] - 0.05, d.pos[2], 0.3, 0.02)).toBe(true)
      expect(world.isBlocked(d.pos[0], d.pos[1] + 0.01, d.pos[2], 0.4, 2)).toBe(false)
      expect(Math.abs(d.pos[0])).toBeLessThan(outpost.bounds.x)
    }
  })

  it('is small enough to cross quickly and has a kill zone below the pit', () => {
    expect(outpost.bounds.x * 2).toBeLessThanOrEqual(70)
    expect(outpost.killY).toBeLessThan(Math.min(...boxes.filter(b => b.id === 'pit_platform').map(b => b.minY)))
    expect(outpost.solids.filter(s => s.kind === 'crate').length).toBeGreaterThanOrEqual(3)
  })
})

const defaults = Object.fromEntries(tuning.controls.map(control => [control.id, control.default]))
afterEach(() => {
  tuning.apply(defaults)
  tuning.activate('jump')
  tuning.activate('run')
})

describe('Three.js tuning', () => {
  it('validates the entire patch before committing and preserves source defaults', () => {
    const before = tuning.read()
    for (const patch of [{ 'player.walkSpeed': 8, 'camera.fov': 999 }, { 'player.walkSpeed': 13 },
      { 'player.walkSpeed': 7.1 }, { 'player.walkSpeed': '8' }, { 'camera.fov': Infinity }, { unknown: 4 }]) {
      expect(() => tuning.apply(patch)).toThrow()
      expect(tuning.read()).toEqual(before)
    }
    tuning.apply({ 'player.walkSpeed': 9, 'player.sprintSpeed': 14 })
    expect(CONFIG.player.walkSpeed).toBe(9)
    expect(DEFAULT_CONFIG.player.walkSpeed).toBe(7)
  })

  it('keeps next-jump values pending until a jump starts and then drives the real player', () => {
    tuning.apply({ 'player.jumpSpeed': 12 })
    expect(CONFIG.player.jumpSpeed).toBe(DEFAULT_CONFIG.player.jumpSpeed)
    const p = new Player(floor(), { x: 20, z: 20, ceiling: 40, killY: -24 })
    p.spawn(0, 0, 0, 0)
    for (let i = 0; i < 30; i++) p.step(1 / 60, { moveX: 0, moveY: 0, sprint: false, jumpPressed: false, jumpHeld: false }, 0, [])
    p.step(1 / 60, { moveX: 0, moveY: 0, sprint: false, jumpPressed: true, jumpHeld: false }, 0, [])
    expect(CONFIG.player.jumpSpeed).toBe(12)
    expect(p.body.vy).toBeCloseTo(12 + CONFIG.player.gravity / 60, 1)
  })

  it('marks runs with changed gameplay values as unranked until a clean new run', () => {
    tuning.activate('run')
    tuning.apply({ 'camera.fov': 90 })
    expect(tuning.unranked).toBe(false)
    tuning.apply({ 'jetpack.drainPerSecond': 20 })
    expect(tuning.unranked).toBe(true)
    tuning.apply(defaults)
    expect(tuning.unranked).toBe(true)
    tuning.activate('run')
    expect(tuning.unranked).toBe(false)
  })
})

