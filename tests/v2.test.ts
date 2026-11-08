import { describe, expect, it } from 'vitest'
import { ARENA, buildWorld } from '../src/shared/arenaData'
import { DEFAULT_COSMETICS, randomCosmetics, sanitizeCosmetics, sanitizeName, SLOT_ORDER, SLOT_OPTIONS } from '../src/shared/cosmetics'
import { GRENADES, GrenadeStock } from '../src/shared/grenades'
import { MatchSim, STEP } from '../src/shared/match'
import { parseClientMessage, sanitizeSettings, normalizeRoomCode } from '../src/shared/protocol'
import { NEUTRAL_INPUT, sanitizeFrame, type InputFrame } from '../src/shared/playerSim'
import { Loadout, WEAPONS, damageAt, weaponById } from '../src/shared/weapons'
import { DEFAULT_OPTIONS, GameServer, type Peer } from '../server/rooms'

/** Small deterministic RNG so simulations are repeatable. */
function seeded(seed = 7): () => number {
  let s = seed
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
}

let seqCounter = 0
const frame = (over: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, seq: seqCounter++, ...over })

function versus(extra: Partial<ConstructorParameters<typeof MatchSim>[0]> = {}) {
  const sim = new MatchSim({ mode: 'versus', rng: seeded(), killLimit: 3, timeLimitSeconds: 600, ...extra })
  const a = sim.addPlayer('a', 'Alpha', DEFAULT_COSMETICS, 0)
  const b = sim.addPlayer('b', 'Bravo', DEFAULT_COSMETICS, 1)
  for (let i = 0; i < 60 * 3.2; i++) sim.step(STEP) // countdown + spawn protection
  return { sim, a, b }
}
function place(p: { state: { body: { x: number; y: number; z: number } }; yaw: number }, x: number, y: number, z: number, yaw = 0): void {
  Object.assign(p.state.body, { x, y, z, vx: 0, vy: 0, vz: 0 })
  p.yaw = yaw
}
/** Push one frame per tick for `ticks` ticks. */
function run(sim: MatchSim, id: string, ticks: number, make: (i: number) => Partial<InputFrame>): void {
  for (let i = 0; i < ticks; i++) {
    sim.pushInputs(id, [frame(make(i))])
    sim.step(STEP)
  }
}

describe('arena data', () => {
  const world = buildWorld()
  const inside = (x: number, y: number, z: number, pad: number) =>
    ARENA.solids.find(s => Math.abs(x - s.pos[0]) < s.size[0] / 2 + pad && Math.abs(y - s.pos[1]) < s.size[1] / 2 + pad && Math.abs(z - s.pos[2]) < s.size[2] / 2 + pad)

  it('has two team spawn groups standing on solid ground and not inside geometry', () => {
    expect(ARENA.spawns.filter(s => s.team === 0).length).toBeGreaterThanOrEqual(3)
    expect(ARENA.spawns.filter(s => s.team === 1).length).toBeGreaterThanOrEqual(3)
    for (const s of ARENA.spawns) {
      expect(inside(s.x, s.y + 0.9, s.z, 0.3), s.id).toBeUndefined()
      expect(world.raycast(s.x, s.y + 0.5, s.z, 0, -1, 0, 1.0), `${s.id} has ground`).not.toBeNull()
    }
  })
  it('places pickups and dummies in open air, with ground under the dummies', () => {
    expect(ARENA.pickups.length).toBeGreaterThanOrEqual(8)
    for (const p of ARENA.pickups) expect(inside(p.x, p.y, p.z, 0.25), p.id).toBeUndefined()
    for (const d of ARENA.dummies) expect(world.raycast(d.x, d.y + 0.5, d.z, 0, -1, 0, 1.0), d.id).not.toBeNull()
  })
  it('keeps every solid inside the invisible bounds', () => {
    for (const s of ARENA.solids) {
      expect(Math.abs(s.pos[0]) + s.size[0] / 2, s.id).toBeLessThanOrEqual(ARENA.bounds.x)
      expect(Math.abs(s.pos[2]) + s.size[2] / 2, s.id).toBeLessThanOrEqual(ARENA.bounds.z)
    }
  })
})

describe('cosmetics and names', () => {
  it('only accepts known ids and fills the rest with defaults', () => {
    const c = sanitizeCosmetics({ skin: 'tone4', head: 'laser_crown', torso: 123 })
    expect(c.skin).toBe('tone4')
    expect(c.head).toBe(DEFAULT_COSMETICS.head)
    expect(c.torso).toBe(DEFAULT_COSMETICS.torso)
    expect(Object.keys(sanitizeCosmetics(null))).toHaveLength(SLOT_ORDER.length)
  })
  it('offers every slot from the supplied catalog', () => {
    expect(SLOT_OPTIONS.skin).toHaveLength(6)
    expect(SLOT_OPTIONS.head).toHaveLength(5)
    expect(SLOT_OPTIONS.face).toHaveLength(4)
    expect(SLOT_OPTIONS.jetpack_flame.map(o => o.id)).toEqual(['orange', 'blue', 'green', 'pink'])
    const r = randomCosmetics(seeded(3))
    for (const slot of SLOT_ORDER) expect(SLOT_OPTIONS[slot].some(o => o.id === r[slot])).toBe(true)
  })
  it('cleans display names', () => {
    expect(sanitizeName('  Max   Militia ')).toBe('Max Militia')
    expect(sanitizeName('<b>Hi</b>')).toBe('bHi/b')
    expect(sanitizeName('a')).toBeNull()
    expect(sanitizeName('x'.repeat(40))).toBeNull()
    expect(sanitizeName('ab\u0000cd')).toBe('abcd')
    expect(sanitizeName(42)).toBeNull()
  })
})

describe('protocol validation', () => {
  it('rejects malformed json, unknown types and bad codes', () => {
    expect(parseClientMessage('not json').ok).toBe(false)
    expect(parseClientMessage('{"t":"hack"}').ok).toBe(false)
    expect(parseClientMessage('{"t":"join","code":"abc","name":"Neo"}').ok).toBe(false)
    expect(normalizeRoomCode(' k7m2p ')).toBe('K7M2P')
    expect(normalizeRoomCode('K7M2O')).toBeNull() // O is not in the alphabet
  })
  it('clamps input frames and drops invalid ones', () => {
    const f = sanitizeFrame({ seq: 4, mx: 9, my: 9, pitch: 99, lag: 99999, slot: 7, gsel: 99, fireHeld: 'yes' })!
    expect(Math.hypot(f.mx, f.my)).toBeLessThanOrEqual(1.0001)
    expect(f.pitch).toBeLessThan(1.3)
    expect(f.lag).toBe(250)
    expect(f.slot).toBe(-1)
    expect(f.gsel).toBe(-1)
    expect(f.fireHeld).toBe(false)
    expect(sanitizeFrame({ seq: -1 })).toBeNull()
    expect(sanitizeFrame({ seq: 1.5 })).toBeNull()
  })
  it('clamps room settings into the allowed ranges', () => {
    expect(sanitizeSettings({ killLimit: 9999, timeLimitMinutes: 0 })).toEqual({ killLimit: 50, timeLimitMinutes: 2 })
    expect(sanitizeSettings({ killLimit: 'x', timeLimitMinutes: 3 })).toBeNull()
  })
})

describe('weapons', () => {
  it('ships six weapons with sane stats and the starters first', () => {
    expect(WEAPONS.map(w => w.id)).toEqual(['uzi', 'deagle', 'ak47', 'shotgun', 'sniper', 'magnum'])
    for (const w of WEAPONS) { expect(w.damage).toBeGreaterThan(0); expect(w.clip).toBeGreaterThan(0); expect(w.pellets).toBeGreaterThanOrEqual(1) }
    expect(weaponById('shotgun').pellets).toBeGreaterThan(1)
  })
  it('applies range falloff', () => {
    const s = weaponById('shotgun')
    expect(damageAt(s, 0)).toBeCloseTo(s.damage)
    expect(damageAt(s, s.range)).toBeCloseTo(s.damage * s.falloff)
    expect(damageAt(s, s.range * 5)).toBeCloseTo(s.damage * s.falloff)
  })
  it('equips pickups into the right slot and restores the starters', () => {
    const l = new Loadout()
    l.equip(weaponById('sniper'))
    expect(l.weapon.def.id).toBe('sniper')
    expect(l.slots[1].def.id).toBe('deagle')
    l.equip(weaponById('magnum'))
    expect(l.slots[1].def.id).toBe('magnum')
    const copy = l.clone()
    expect(copy.toState()).toEqual(l.toState())
    l.resetToStarters()
    expect(l.slots.map(s => s.def.id)).toEqual(['uzi', 'deagle'])
  })
})

describe('grenade stock', () => {
  it('has exactly three grenade types', () => {
    expect(Object.keys(GRENADES).sort()).toEqual(['frag', 'gas', 'prox'])
  })
  it('spends, rejects at zero and recharges over time', () => {
    const g = new GrenadeStock()
    g.select(1)
    expect(g.tryThrow()).toBe(1)
    g.cooldown = 0
    expect(g.tryThrow()).toBe(-1) // gas starts at 1
    for (let i = 0; i < 60 * (GRENADES.gas.rechargeSeconds + 1); i++) g.update(STEP)
    expect(g.count[1]).toBe(1)
  })
})

describe('match: shooting and respawn', () => {
  it('kills in four deagle body shots, scores, respawns after 3 s and resets weapons', () => {
    const { sim, a, b } = versus()
    place(a, -8, 0, -3, -Math.PI / 2)
    place(b, 2, 0, -2.15, 0)
    a.state.loadout.select(1)
    run(sim, 'a', 30, () => ({})) // weapon timers advance with input frames
    const aim = { yaw: -Math.PI / 2, pitch: -0.07 }
    // 4 pulls, one per 0.4 s.
    for (let shot = 0; shot < 4; shot++) {
      run(sim, 'a', 1, () => ({ ...aim, firePressed: true, fireHeld: true, slot: shot === 0 ? 1 : -1 }))
      run(sim, 'a', 24, () => ({ ...aim }))
    }
    expect(b.dead).toBe(true)
    expect(a.kills).toBe(1)
    expect(sim.scores[0]).toBe(1)
    run(sim, 'b', 60 * 3 + 5, () => ({}))
    expect(b.dead).toBe(false)
    expect(b.health).toBe(100)
    expect(b.state.loadout.slots.map(s => s.def.id)).toEqual(['uzi', 'deagle'])
  })
  it('does not hurt teammates and ignores targets protected after spawning', () => {
    const { sim, a, b } = versus()
    b.team = 0
    place(a, -8, 0, -3, -Math.PI / 2)
    place(b, 2, 0, -2.15, 0)
    run(sim, 'a', 30, () => ({ yaw: -Math.PI / 2, pitch: -0.07, firePressed: true, fireHeld: true }))
    expect(b.health).toBe(100)
    b.team = 1
    b.protectLeft = 1
    run(sim, 'a', 30, () => ({ yaw: -Math.PI / 2, pitch: -0.07, firePressed: true, fireHeld: true }))
    expect(b.health).toBe(100)
  })
  it('dies in the kill zone and credits the last damager', () => {
    const { sim, a, b } = versus()
    place(a, -8, 0, -3)
    place(b, 2, 0, -2.15)
    b.lastDamager = { id: 'a', t: sim.time }
    place(b, 30, -23, 0)
    run(sim, 'b', 3, () => ({}))
    expect(b.dead).toBe(true)
    expect(a.kills).toBe(1)
  })
  it('ends the match at the kill limit and reports a winner', () => {
    const { sim, a, b } = versus({ killLimit: 1 })
    place(b, 30, -23, 0)
    b.lastDamager = { id: 'a', t: sim.time }
    run(sim, 'b', 3, () => ({}))
    expect(a.kills).toBe(1)
    expect(sim.phase).toBe('results')
    expect(sim.winner).toBe(0)
  })
})

describe('match: practice dummies', () => {
  it('damages, kills and respawns a dummy', () => {
    const sim = new MatchSim({ mode: 'practice', rng: seeded() })
    const p = sim.addPlayer('me', 'Me', DEFAULT_COSMETICS, 0)
    place(p, -4, 0, -2.85, -Math.PI / 2) // dummy_core is at x=4,z=-2; crosshair line is 0.85 to the right of the body
    p.state.loadout.select(1)
    run(sim, 'me', 30, () => ({}))
    const d = sim.dummies[0]
    for (let shot = 0; shot < 6 && d.alive; shot++) {
      run(sim, 'me', 1, () => ({ yaw: -Math.PI / 2, pitch: -0.045, firePressed: true, fireHeld: true, slot: shot === 0 ? 1 : -1 }))
      run(sim, 'me', 24, () => ({ yaw: -Math.PI / 2, pitch: -0.045 }))
    }
    expect(d.alive).toBe(false)
    run(sim, 'me', 60 * 5, () => ({}))
    expect(d.alive).toBe(true)
    expect(d.hp).toBe(d.spec.hp)
  })
})

describe('match: grenades', () => {
  it('frag: damages enemies with falloff, hurts the thrower at half, ignores teammates, is blocked by cover', () => {
    const { sim, a, b } = versus()
    const c = sim.addPlayer('c', 'Charlie', DEFAULT_COSMETICS, 0)
    place(a, 2, 0, -3)
    place(b, 3, 0, -3)
    place(c, 2.2, 0, -3.5)
    sim.launchGrenade(a, 0, 2, 1, -3, 0, 0, 0)
    for (let i = 0; i < 60 * 3; i++) sim.step(STEP)
    expect(b.health).toBeLessThan(60)
    expect(b.health).toBeGreaterThan(0)
    expect(c.health).toBe(100)
    expect(a.health).toBeLessThan(100)
    expect(a.health).toBeGreaterThan(100 - 90) // self damage is halved
    // Cover blocks: crate_core_a sits at (-5.5, .8, 5.5).
    const { sim: s2, a: a2, b: b2 } = versus()
    place(a2, 10, 0, 10)
    place(b2, -5.5, 0, 6.8)
    s2.launchGrenade(a2, 0, -5.5, 0.4, 4.2, 0, 0, 0)
    for (let i = 0; i < 60 * 3; i++) s2.step(STEP)
    expect(b2.health).toBe(100)
  })
  it('gas: leaves a cloud that ticks damage then expires', () => {
    const { sim, a, b } = versus()
    place(a, 15, 0, 8)
    place(b, 3, 0, -3)
    sim.launchGrenade(a, 1, 2, 1, -3, 0, 0, 0)
    for (let i = 0; i < 60 * 3; i++) sim.step(STEP)
    expect(sim.clouds.length).toBe(1)
    expect(b.health).toBeLessThan(100)
    for (let i = 0; i < 60 * 8; i++) sim.step(STEP)
    expect(sim.clouds.length).toBe(0)
    expect(b.health).toBeGreaterThan(0)
    expect(b.health).toBeLessThan(60)
  })
  it('proximity: arms after landing and blows up when an enemy comes close', () => {
    const { sim, a, b } = versus()
    place(a, 15, 0, 8)
    place(b, 12, 0, 8)
    sim.launchGrenade(a, 2, 2, 1, -3, 0, 0, 0)
    for (let i = 0; i < 60 * 4; i++) sim.step(STEP)
    expect(sim.grenades.length).toBe(1) // armed, nobody near
    expect(b.health).toBe(100)
    place(b, 3, 0, -3)
    for (let i = 0; i < 60 * 2; i++) sim.step(STEP)
    expect(sim.grenades.length).toBe(0)
    expect(b.health).toBeLessThan(60)
  })
})

describe('match: pickups', () => {
  it('are rolled by the server from the tier pool and claimed by exactly one player', () => {
    const { sim, a, b } = versus()
    const spot = ARENA.pickups.findIndex(p => p.id === 'pk_core_n')
    for (let i = 0; i < 60 * 6; i++) {
      place(a, 0, 0, 7)
      place(b, 0, 0, 7)
      sim.step(STEP)
    }
    const starters = ['uzi', 'deagle']
    const upgraded = [a, b].filter(p => p.state.loadout.slots.some(s => !starters.includes(s.def.id)))
    expect(upgraded).toHaveLength(1)
    expect(sim.pickups[spot].weapon).toBeNull() // consumed, waiting to respawn
    expect(['ak47', 'shotgun', 'magnum']).toContain(upgraded[0].state.loadout.slots.find(s => !starters.includes(s.def.id))!.def.id)
  })
})

describe('match: anti-cheat input budget', () => {
  it('never simulates a flooding client faster than real time', () => {
    const { sim, a } = versus()
    place(a, -8, 0, -3)
    const before = a.framesProcessed
    for (let i = 0; i < 60; i++) {
      sim.pushInputs('a', Array.from({ length: 12 }, () => frame({ my: 1, yaw: 0 })))
      sim.step(STEP)
    }
    expect(a.framesProcessed - before).toBeLessThanOrEqual(60 + 8) // one second of ticks plus the burst allowance
  })
})

// ---- server rooms ----------------------------------------------------------------------------
class FakePeer implements Peer {
  inbox: Record<string, any>[] = []
  closed = false
  send(data: string): void { this.inbox.push(JSON.parse(data)) }
  close(): void { this.closed = true }
  last(t: string): Record<string, any> | undefined { return [...this.inbox].reverse().find(m => m.t === t) }
  all(t: string): Record<string, any>[] { return this.inbox.filter(m => m.t === t) }
}

function setup(over: Partial<typeof DEFAULT_OPTIONS> = {}) {
  let clock = 1_000_000
  const server = new GameServer({ ...DEFAULT_OPTIONS, now: () => clock, rng: seeded(11), ...over })
  const tick = (ms: number) => { clock += ms }
  const client = (name = 'Player') => {
    const peer = new FakePeer()
    const conn = server.connect(peer)
    const send = (msg: unknown) => server.onMessage(conn, JSON.stringify(msg))
    return { peer, conn, send, name }
  }
  return { server, client, tick }
}

describe('game server', () => {
  it('creates a room, lets others join by code, enforces the player cap and host-only start', () => {
    const { server, client } = setup({ maxPlayers: 2 })
    const host = client()
    host.send({ t: 'create', name: 'Host', cosmetics: {} })
    const code = host.peer.last('welcome')!.code as string
    expect(code).toMatch(/^[A-Z2-9]{5}$/)
    expect(host.peer.last('lobby')!.roster).toHaveLength(1)

    const guest = client()
    guest.send({ t: 'join', code, name: 'Guest', cosmetics: {} })
    expect(guest.peer.last('welcome')).toBeDefined()
    expect(host.peer.last('lobby')!.roster).toHaveLength(2)

    const third = client()
    third.send({ t: 'join', code, name: 'Third', cosmetics: {} })
    expect(third.peer.last('error')!.code).toBe('room_full')
    const nowhere = client()
    nowhere.send({ t: 'join', code: 'ZZZZZ', name: 'Nobody', cosmetics: {} })
    expect(nowhere.peer.last('error')!.code).toBe('no_room')

    guest.send({ t: 'start' })
    expect(guest.peer.last('error')!.code).toBe('not_host')
    guest.send({ t: 'settings', settings: { killLimit: 5, timeLimitMinutes: 3 } })
    expect(guest.peer.last('error')!.code).toBe('not_host')
    host.send({ t: 'settings', settings: { killLimit: 5, timeLimitMinutes: 3 } })
    expect(host.peer.last('lobby')!.settings).toEqual({ killLimit: 5, timeLimitMinutes: 3 })
    expect(server.stats().rooms).toBe(1)
  })

  it('rejects bad names and escapes nothing it should not trust', () => {
    const { client } = setup()
    const c = client()
    c.send({ t: 'create', name: '', cosmetics: {} })
    expect(c.peer.last('error')!.code).toBe('bad_name')
    c.send({ t: 'create', name: 'Neo', cosmetics: { skin: 'hax', head: 'cap' } })
    const lobby = c.peer.last('lobby')!
    expect(lobby.roster[0].cosmetics.skin).toBe(DEFAULT_COSMETICS.skin)
  })

  it('starts a match, streams snapshots with the private state and accepts input', () => {
    const { server, client } = setup()
    const host = client()
    host.send({ t: 'create', name: 'Host', cosmetics: {} })
    const code = host.peer.last('welcome')!.code as string
    const guest = client()
    guest.send({ t: 'join', code, name: 'Guest', cosmetics: {} })
    host.send({ t: 'start' })
    expect(host.peer.last('lobby')!.state).toBe('match')
    for (let i = 0; i < 6 * 60; i++) {
      host.send({ t: 'input', frames: [{ seq: i, my: 1, yaw: 0, pitch: 0 }] })
      server.advance(STEP)
    }
    const snap = host.peer.last('snap')!.s
    expect(snap.p).toHaveLength(2)
    expect(snap.you).not.toBeNull()
    expect(snap.ph).toBe('live')
    expect(snap.ack).toBeGreaterThan(100)
    expect(guest.peer.last('snap')!.s.p).toHaveLength(2)
    // Teams are balanced.
    expect(new Set(snap.p.map((p: { t: number }) => p.t)).size).toBe(2)
  })

  it('lets a dropped player resume with their token inside the grace window only', () => {
    const { server, client, tick } = setup({ graceMs: 5000 })
    const host = client()
    host.send({ t: 'create', name: 'Host', cosmetics: {} })
    const w = host.peer.last('welcome')!
    server.disconnect(host.conn)
    tick(2000)
    const back = client()
    back.send({ t: 'resume', code: w.code, token: w.token })
    expect(back.peer.last('welcome')!.id).toBe(w.id)
    server.disconnect(back.conn)
    tick(6000)
    server.sweep()
    const late = client()
    late.send({ t: 'resume', code: w.code, token: w.token })
    expect(late.peer.last('error')!.code).toBe('bad_token')
  })

  it('rate limits floods', () => {
    const { client } = setup({ rateBurst: 30, rateSustained: 10 })
    const c = client()
    for (let i = 0; i < 200; i++) c.send({ t: 'ping', c: i })
    expect(c.peer.all('pong').length).toBeLessThanOrEqual(31)
    expect(c.peer.last('error')!.code).toBe('rate_limited')
  })

  it('hands the host to the next player when the host leaves', () => {
    const { client } = setup()
    const host = client()
    host.send({ t: 'create', name: 'Host', cosmetics: {} })
    const code = host.peer.last('welcome')!.code as string
    const guest = client()
    guest.send({ t: 'join', code, name: 'Guest', cosmetics: {} })
    const guestId = guest.peer.last('welcome')!.id
    host.send({ t: 'leave' })
    expect(guest.peer.last('lobby')!.hostId).toBe(guestId)
  })
})



