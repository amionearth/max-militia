import * as THREE from 'three'
import type { Audio, Sfx } from '../engine/audio'
import type { Input } from '../engine/input'
import type { Renderer } from '../engine/renderer'
import { ARENA } from '../shared/arenaData'
import type { Cosmetics } from '../shared/cosmetics'
import { GRENADE_KINDS, GRENADES } from '../shared/grenades'
import type { NetEvent, MatchPhase } from '../shared/match'
import type { InputFrame, SimEvent } from '../shared/playerSim'
import { findWeapon } from '../shared/weapons'
import { LocalSession, RemoteSession, type PlayerView, type ScoreRow, type Session } from '../net/session'
import type { RoomClient } from '../net/room'
import { Avatar, TEAM_COLORS } from './avatar'
import { ThirdPersonCamera } from './camera'
import { CONFIG } from './config'
import { DummyView } from './dummy'
import { ParticleSystem, Tracers } from './fx'
import { Arena } from './map'
import { tuning } from './tuning'
import { WorldFx } from './worldfx'

export type Mode = 'attract' | 'locker' | 'playing' | 'paused' | 'results'
export type HitKind = 'hit' | 'head' | 'kill'

export type FeedEntry = { killer: string; killerTeam: number; victim: string; victimTeam: number; weapon: string; head: boolean; mine: boolean; me: boolean }

export type HudGrenade = { name: string; key: string; color: string; count: number; max: number }
export type HudInfo = {
  health: number; maxHealth: number
  fuel: number; maxFuel: number; thrusting: boolean; fuelLocked: boolean
  weapon: string; weaponId: string; ammo: number; clip: number
  /** Reload progress 0..1, or 0 when not reloading. */
  reload: number
  /** Current aim cone in degrees (drives crosshair spread). */
  spread: number
  dead: boolean; respawn: number; deathReason: string; protect: boolean
  grenades: HudGrenade[]; grenadeSelected: number; grenadeCooldown: number
  pickupNear: string
  phase: MatchPhase; timeLeft: number; scores: number[]; killLimit: number
  practice: boolean; team: number; ping: number
}

export type GameHooks = {
  hit(kind: HitKind): void
  /** Angle of the damage source relative to the view: 0 ahead, +PI/2 right. */
  damage(angle: number): void
  death(show: boolean, reason: string): void
  feed(entry: FeedEntry): void
  banner(text: string): void
  phase(phase: MatchPhase, winner: number): void
}

const SPARK_WORLD = new THREE.Color('#ffc46b')
const SPARK_BODY = new THREE.Color('#ff4d6d')
const SMOKE = new THREE.Color('#5a4a8a')
const TEAM_HEX = ['#ff6b86', '#6aa8ff']

type Rig = { avatar: Avatar; thrust: number; sig: string; dead: boolean; cosSig: string }

export class Game {
  mode: Mode = 'attract'
  reducedMotion = false
  readonly arena: Arena
  session: Session | null = null
  private readonly cam: ThirdPersonCamera
  private readonly avatar: Avatar
  private readonly rigs = new Map<string, Rig>()
  private readonly dummies: DummyView[] = ARENA.dummies.map(d => new DummyView(d))
  private readonly sparks = new ParticleSystem(520, 0.14, -14)
  private readonly flames = new ParticleSystem(900, 0.42, 1.5)
  private readonly tracers = new Tracers(72)
  private readonly world: WorldFx
  private readonly locker = new THREE.Group()
  private lockerYaw = 0.5
  private time = 0
  private thrustVisual = 0
  private deathReason = ''
  private wasDead = false
  private ownCosmetics: Cosmetics
  private ownName = 'Pilot'
  private lastPhase: MatchPhase | '' = ''
  private pickupNear = ''
  private readonly feet = new THREE.Vector3()
  private readonly tmpA = new THREE.Vector3()
  private readonly tmpB = new THREE.Vector3()
  private readonly tmpC = new THREE.Vector3()

  constructor(
    private readonly renderer: Renderer,
    private readonly input: Input,
    private readonly audio: Audio,
    private readonly hooks: GameHooks,
    cosmetics: Cosmetics,
  ) {
    this.ownCosmetics = cosmetics
    this.arena = new Arena(renderer.shadowMapSize)
    this.cam = new ThirdPersonCamera(this.arena.world)
    this.avatar = new Avatar(cosmetics, TEAM_COLORS[0])
    this.world = new WorldFx(this.sparks)
    this.arena.scene.add(this.sparks.points, this.flames.points, this.tracers.group, this.world.group, ...this.dummies.map(d => d.root))
    this.arena.scene.add(this.avatar.root)
    this.avatar.setVisible(false)
    for (const d of this.dummies) d.root.visible = false
    this.buildLocker()
  }

  get camera(): THREE.PerspectiveCamera { return this.cam.camera }
  get online(): boolean { return this.session?.kind === 'online' }

  // ---- modes ---------------------------------------------------------------------------------
  private buildLocker(): void {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.9, 0.3, 28), new THREE.MeshStandardMaterial({ color: 0x20264a, roughness: 0.5, metalness: 0.5 }))
    base.position.y = -0.15
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.04, 6, 48), new THREE.MeshBasicMaterial({ color: 0x22e6ff }))
    ring.rotation.x = Math.PI / 2
    this.locker.add(base, ring)
    this.locker.position.set(0, 90, -40)
    this.locker.visible = false
    this.arena.scene.add(this.locker)
  }

  private setAvatarSource(): void {
    const t = this.session?.info.team ?? 0
    this.avatar.setTeamColor(TEAM_COLORS[t] ?? TEAM_COLORS[0])
    this.avatar.setCosmetics(this.ownCosmetics)
  }

  setCosmetics(c: Cosmetics): void {
    this.ownCosmetics = c
    this.avatar.setCosmetics(c)
  }

  showTitle(): void {
    this.endSession()
    this.mode = 'attract'
    this.locker.visible = false
    this.hooks.death(false, '')
  }

  /** Close-up of the player's avatar on a pedestal for the customization screen. */
  showLocker(cosmetics: Cosmetics, team = 0): void {
    this.endSession()
    this.mode = 'locker'
    this.ownCosmetics = cosmetics
    this.avatar.setTeamColor(TEAM_COLORS[team] ?? TEAM_COLORS[0])
    this.avatar.setCosmetics(cosmetics)
    this.avatar.setVisible(true)
    this.avatar.root.position.copy(this.locker.position)
    this.locker.visible = true
  }

  lockerDrag(dx: number): void { this.lockerYaw -= dx * 0.01 }
  lockerEmote(): void { this.avatar.playEmote(); this.audio.play('emote') }

  startPractice(name: string, cosmetics: Cosmetics): void {
    this.beginSession(new LocalSession(name, cosmetics), name, cosmetics)
    for (const d of this.dummies) d.root.visible = true
  }

  startOnline(room: RoomClient, name: string, cosmetics: Cosmetics): void {
    this.beginSession(new RemoteSession(room), name, cosmetics)
    for (const d of this.dummies) d.root.visible = false
  }

  private beginSession(session: Session, name: string, cosmetics: Cosmetics): void {
    this.endSession()
    tuning.activate('run')
    this.session = session
    this.ownName = name
    this.ownCosmetics = cosmetics
    this.locker.visible = false
    this.mode = 'playing'
    this.wasDead = false
    this.deathReason = ''
    this.lastPhase = ''
    this.thrustVisual = 0
    this.setAvatarSource()
    this.avatar.setVisible(true)
    const b = session.me.body
    this.cam.yaw = b.x < 0 ? -Math.PI / 2 : Math.PI / 2
    this.cam.pitch = 0.12
    this.cam.reset()
    this.input.flush()
    this.hooks.death(false, '')
  }

  endSession(): void {
    if (this.session) this.session.close()
    this.session = null
    for (const rig of this.rigs.values()) this.arena.scene.remove(rig.avatar.root)
    this.rigs.clear()
    this.world.syncGrenades([])
    this.world.syncClouds([], 0)
    this.world.syncPickups(ARENA.pickups.map(() => ''))
    this.avatar.setVisible(false)
    for (const d of this.dummies) d.root.visible = false
    this.audio.setJet(0)
    this.mode = 'attract'
  }

  pause(): void {
    if (this.mode === 'playing') this.mode = 'paused'
    if (!this.online) this.audio.setJet(0)
  }

  resume(): void {
    if (this.mode !== 'paused') return
    this.mode = 'playing'
    this.input.flush()
  }

  // ---- fixed step ----------------------------------------------------------------------------
  step(dt: number): void {
    const inp = this.input
    const jumpPressed = inp.consume('jump')
    const firePressed = inp.consume('fire')
    const reload = inp.consume('reload')
    const slot1 = inp.consume('slot1')
    const slot2 = inp.consume('slot2')
    const swap = inp.consume('swap')
    const doThrow = inp.consume('throw')
    const g1 = inp.consume('gren1')
    const g2 = inp.consume('gren2')
    const g3 = inp.consume('gren3')
    const gc = inp.consume('gcycle')
    const emote = inp.consume('emote')
    const s = this.session
    if (!s) return
    const active = this.mode === 'playing'
    // While paused online the match keeps running, so keep sending neutral input.
    if (!active && !(this.online && (this.mode === 'paused' || this.mode === 'results'))) return
    const frame: InputFrame = {
      seq: 0,
      mx: active ? inp.move.x : 0,
      my: active ? inp.move.y : 0,
      sprint: active && inp.held('sprint'),
      jumpHeld: active && inp.held('jump'),
      jumpPressed: active && jumpPressed,
      fireHeld: active && inp.held('fire'),
      firePressed: active && firePressed,
      reload: active && reload,
      slot: !active ? -1 : slot1 ? 0 : slot2 ? 1 : swap ? 2 : -1,
      throw: active && doThrow,
      gsel: !active ? -1 : g1 ? 0 : g2 ? 1 : g3 ? 2 : gc ? 3 : -1,
      yaw: this.cam.yaw,
      pitch: this.cam.pitch,
      lag: 0,
      emote: active && emote,
    }
    const events = s.step(frame, dt)
    for (const e of events) this.onLocalEvent(e)
  }

  private onLocalEvent(e: SimEvent): void {
    const s = this.session!
    const b = s.me.body
    switch (e.type) {
      case 'jump': this.audio.play('jump'); break
      case 'land':
        this.audio.play('land')
        this.cam.addShake(Math.min(0.25, e.impact * 0.01))
        for (let i = 0; i < 6; i++) this.sparks.emit(b.x, b.y + 0.05, b.z, (Math.random() - 0.5) * 4, 1 + Math.random() * 2, (Math.random() - 0.5) * 4, SMOKE, 0.35)
        break
      case 'fired': {
        const def = findWeapon(e.weaponId)
        if (!def) break
        this.avatar.showMuzzleFlash()
        this.audio.play(def.sound as Sfx)
        this.cam.addShake(def.shake)
        break
      }
      case 'dry': this.audio.play('empty'); break
      case 'reloadStart': this.audio.play('reload_out'); break
      case 'reloaded': this.audio.play('reload_in'); break
      case 'swap': this.audio.play('swap'); this.avatar.selectWeapon(e.weaponId); break
      case 'throw': this.audio.play('throw'); break
      case 'gsel': this.audio.play('ui'); break
      default: break
    }
  }

  // ---- render --------------------------------------------------------------------------------
  render(alpha: number, frameSeconds: number): void {
    this.time += frameSeconds
    const now = performance.now()
    const s = this.session
    this.arena.update(this.time)
    this.updateLocalAndCamera(alpha, frameSeconds)

    if (s) {
      this.handleEvents(s)
      this.updateRemotes(s, now, frameSeconds)
      this.world.syncGrenades(s.grenades(now))
      this.world.syncClouds(s.clouds, frameSeconds)
      this.world.syncPickups(s.pickups)
      s.dummies.forEach((d, i) => this.dummies[i]?.sync(d.hp, d.a === 1))
      this.updatePickupHint(s)
      this.trackPhase(s)
    }
    for (const d of this.dummies) if (d.root.visible) d.update(frameSeconds, this.cam.camera)
    this.world.update(frameSeconds)
    this.tracers.update(frameSeconds)
    this.sparks.update(frameSeconds)
    this.flames.update(frameSeconds)
    this.renderer.render(this.arena.scene, this.cam.camera)
  }

  private updateLocalAndCamera(alpha: number, fs: number): void {
    const s = this.session
    const cam = this.cam.camera
    if (this.mode === 'locker') {
      this.lockerYaw += fs * 0.25
      const c = this.locker.position
      cam.position.set(c.x + Math.sin(this.lockerYaw) * 4.3, c.y + 1.7, c.z + Math.cos(this.lockerYaw) * 4.3)
      cam.lookAt(c.x, c.y + 1.15, c.z)
      this.avatar.root.position.copy(c)
      this.avatar.root.rotation.y = 0
      this.avatar.animate(fs, this.time, { speed: 0, grounded: true, thrust: 0, pitch: 0, weaponId: 'uzi' })
      return
    }
    if (!s || this.mode === 'attract' || this.mode === 'results') {
      const t = this.time * 0.07 + 0.6
      cam.position.set(Math.sin(t) * 46, 15 + Math.sin(this.time * 0.25) * 2, Math.cos(t) * 30)
      cam.lookAt(0, 7, 0)
      if (s) this.animateLocal(s, alpha, fs)
      return
    }
    const p = s.me
    const corr = s.correction(fs)
    this.feet.set(
      s.prev.x + (p.body.x - s.prev.x) * alpha + corr.x,
      s.prev.y + (p.body.y - s.prev.y) * alpha + corr.y,
      s.prev.z + (p.body.z - s.prev.z) * alpha + corr.z,
    )
    const look = this.mode === 'playing' ? this.input.takeLook() : { x: 0, y: 0 }
    this.cam.update(this.feet, look, fs, this.reducedMotion)
    this.animateLocal(s, alpha, fs)
    this.emitFlames(this.avatar, p.body.vx, p.body.vz, this.thrustVisual, s.info.dead, fs)
    this.audio.setJet(!s.info.dead ? this.thrustVisual : 0)
    this.trackDeath(s)
  }

  private animateLocal(s: Session, _alpha: number, fs: number): void {
    const p = s.me
    const dead = s.info.dead
    this.avatar.setVisible(!dead)
    this.avatar.root.position.copy(this.feet)
    const target = this.mode === 'playing' || this.mode === 'paused' ? this.cam.yaw : this.avatar.root.rotation.y
    const diff = Math.atan2(Math.sin(target - this.avatar.root.rotation.y), Math.cos(target - this.avatar.root.rotation.y))
    this.avatar.root.rotation.y += diff * Math.min(1, fs * 20)
    const thrustTarget = p.jet.thrusting && !dead ? 1 - 0.35 * Math.min(1, p.jet.hold / CONFIG.jetpack.burstSeconds) : 0
    this.thrustVisual += (thrustTarget - this.thrustVisual) * Math.min(1, fs * 14)
    this.avatar.setShield(s.info.protect)
    this.avatar.animate(fs, this.time, {
      speed: Math.min(1, Math.hypot(p.body.vx, p.body.vz) / CONFIG.player.sprintSpeed),
      grounded: p.grounded,
      thrust: this.thrustVisual,
      pitch: THREE.MathUtils.clamp(this.cam.pitch, -1, 1),
      weaponId: p.loadout.weapon.def.id,
      emote: false,
    })
    // The avatar's shirt colour follows team assignment once the server tells us.
    if (this.online) this.avatar.setTeamColor(TEAM_COLORS[s.info.team] ?? TEAM_COLORS[0])
  }

  private trackDeath(s: Session): void {
    const dead = s.info.dead
    if (dead && !this.wasDead) {
      const b = s.me.body
      this.audio.play('down')
      for (let i = 0; i < 24; i++) this.sparks.emit(b.x, b.y + 1, b.z, (Math.random() - 0.5) * 9, Math.random() * 7, (Math.random() - 0.5) * 9, SPARK_BODY, 0.8)
      if (!this.deathReason) this.deathReason = b.y < ARENA.bounds.killY + 6 ? 'You fell into the void' : 'You were taken out'
      this.hooks.death(true, this.deathReason)
    } else if (!dead && this.wasDead) {
      this.deathReason = ''
      this.cam.yaw = s.me.body.x < 0 ? -Math.PI / 2 : Math.PI / 2
      this.cam.pitch = 0.12
      this.cam.reset()
      this.thrustVisual = 0
      this.input.flush()
      this.audio.play('respawn')
      this.hooks.death(false, '')
    }
    this.wasDead = dead
  }

  private trackPhase(s: Session): void {
    const ph = s.match.phase
    if (ph !== this.lastPhase) {
      if (ph === 'results') this.mode = 'results'
      else if (this.mode === 'results') this.mode = 'playing'
      if (this.lastPhase === 'countdown' && ph === 'live') this.audio.play('go')
      if (this.lastPhase !== '' || ph !== 'live') this.hooks.phase(ph, -1)
      this.lastPhase = ph
    }
  }

  private updatePickupHint(s: Session): void {
    this.pickupNear = ''
    const b = s.me.body
    ARENA.pickups.forEach((spot, i) => {
      const w = s.pickups[i]
      if (!w) return
      if (Math.hypot(spot.x - b.x, spot.y - b.y - 0.9, spot.z - b.z) < 5) this.pickupNear = findWeapon(w)?.name ?? w
    })
  }

  // ---- other players ------------------------------------------------------------------------
  private updateRemotes(s: Session, now: number, fs: number): void {
    const views = s.others(now)
    const seen = new Set<string>()
    const myTeam = s.info.team
    for (const v of views) {
      seen.add(v.id)
      let rig = this.rigs.get(v.id)
      const cosSig = JSON.stringify(v.cosmetics)
      if (!rig) {
        const avatar = new Avatar(v.cosmetics, TEAM_COLORS[v.team] ?? TEAM_COLORS[1])
        this.arena.scene.add(avatar.root)
        rig = { avatar, thrust: 0, sig: '', dead: v.dead, cosSig }
        this.rigs.set(v.id, rig)
      }
      const a = rig.avatar
      if (cosSig !== rig.cosSig && Object.keys(v.cosmetics).length) { a.setCosmetics(v.cosmetics); rig.cosSig = cosSig }
      a.setTeamColor(TEAM_COLORS[v.team] ?? TEAM_COLORS[1])
      const sig = `${v.name}|${v.team}|${myTeam}`
      if (sig !== rig.sig) {
        a.setLabel(v.name, TEAM_HEX[v.team] ?? '#ffffff', v.team === myTeam)
        rig.sig = sig
      }
      if (v.dead && !rig.dead) this.deathBurst(v)
      rig.dead = v.dead
      a.setVisible(!v.dead)
      a.setShield(v.protect)
      a.root.position.set(v.x, v.y, v.z)
      a.root.rotation.y = v.yaw
      rig.thrust += ((v.thrusting && !v.dead ? 1 : 0) - rig.thrust) * Math.min(1, fs * 14)
      a.animate(fs, this.time, { speed: v.speed, grounded: v.grounded, thrust: rig.thrust, pitch: v.pitch, weaponId: v.weapon, emote: v.emote })
      this.tmpA.set(v.x, v.y, v.z)
      if (!v.dead && this.tmpA.distanceTo(this.cam.camera.position) < 70) this.emitFlames(a, 0, 0, rig.thrust, false, fs)
    }
    for (const [id, rig] of this.rigs) {
      if (!seen.has(id)) { this.arena.scene.remove(rig.avatar.root); this.rigs.delete(id) }
    }
  }

  private deathBurst(v: PlayerView): void {
    for (let i = 0; i < 20; i++) this.sparks.emit(v.x, v.y + 1, v.z, (Math.random() - 0.5) * 8, Math.random() * 6, (Math.random() - 0.5) * 8, SPARK_BODY, 0.7)
  }

  private emitFlames(avatar: Avatar, vx: number, vz: number, thrust: number, dead: boolean, fs: number): void {
    if (thrust < 0.05 || dead) return
    const colors = avatar.flameColors
    const a = new THREE.Color(colors.main)
    const b = new THREE.Color(colors.core)
    const count = Math.max(1, Math.round(fs * 60 * 2 * thrust))
    for (let n = 0; n < 2; n++) {
      avatar.nozzleWorld(n as 0 | 1, this.tmpB)
      for (let i = 0; i < count; i++) {
        const spd = 4 + Math.random() * 4
        this.flames.emit(
          this.tmpB.x + (Math.random() - 0.5) * 0.06, this.tmpB.y - 0.05, this.tmpB.z + (Math.random() - 0.5) * 0.06,
          vx * 0.3 + (Math.random() - 0.5) * 1.2, -spd, vz * 0.3 + (Math.random() - 0.5) * 1.2,
          Math.random() < 0.5 ? a : b, 0.28 + Math.random() * 0.18,
        )
      }
      if (Math.random() < 0.4) this.flames.emit(this.tmpB.x, this.tmpB.y - 0.3, this.tmpB.z, Math.random() - 0.5, -2 - Math.random() * 2, Math.random() - 0.5, SMOKE, 0.7)
    }
  }

  // ---- network / simulation events ---------------------------------------------------------
  private volumeAt(x: number, y: number, z: number): number {
    const c = this.cam.camera.position
    const d = Math.hypot(c.x - x, c.y - y, c.z - z)
    return Math.max(0.12, Math.min(1, 1.1 - d / 80))
  }

  private posOf(s: Session, id: string): THREE.Vector3 | null {
    if (id === s.localId) return this.tmpC.copy(s.me.body as unknown as THREE.Vector3)
    const rig = this.rigs.get(id)
    return rig ? this.tmpC.copy(rig.avatar.root.position) : null
  }

  private handleEvents(s: Session): void {
    const me = s.localId
    for (const e of s.takeEvents()) this.handleEvent(s, e, me)
  }

  private handleEvent(s: Session, e: NetEvent, me: string): void {
    switch (e.ev) {
      case 'shot': {
        const def = findWeapon(e.w)
        const mine = e.p === me
        const rig = mine ? null : this.rigs.get(e.p)
        const avatar = mine ? this.avatar : rig?.avatar
        const origin = this.tmpA
        if (avatar) avatar.muzzleWorld(origin)
        else { const p = this.posOf(s, e.p); if (!p) break; origin.set(p.x, p.y + 1.3, p.z) }
        const start = origin.clone()
        for (const end of e.ends) {
          const to = this.tmpB.set(end[0], end[1], end[2])
          this.tracers.spawn(start, to, def?.tracer ?? '#ffffff', e.w === 'sniper' ? 0.06 : e.w === 'deagle' || e.w === 'magnum' ? 0.05 : 0.03)
          const kind = end[3]
          if (kind === 1) {
            for (let i = 0; i < 6; i++) {
              const sp = 2 + Math.random() * 5
              this.sparks.emit(end[0] + end[4] * 0.03, end[1] + end[5] * 0.03, end[2] + end[6] * 0.03,
                end[4] * sp + (Math.random() - 0.5) * 3, end[5] * sp + Math.random() * 2, end[6] * sp + (Math.random() - 0.5) * 3, SPARK_WORLD, 0.25 + Math.random() * 0.2)
            }
          } else if (kind >= 2) {
            for (let i = 0; i < 6; i++) this.sparks.emit(end[0], end[1], end[2], (Math.random() - 0.5) * 6, Math.random() * 5, (Math.random() - 0.5) * 6, SPARK_BODY, 0.4)
          }
        }
        if (!mine) {
          avatar?.showMuzzleFlash()
          this.audio.play((def?.sound ?? 'uzi') as Sfx, this.volumeAt(start.x, start.y, start.z) * 0.9)
        }
        break
      }
      case 'hit': {
        if (e.a === me && e.v !== me) {
          this.audio.play(e.kill ? 'kill' : e.head ? 'headshot' : 'hit')
          this.hooks.hit(e.kill ? 'kill' : e.head ? 'head' : 'hit')
        }
        if (e.v === me) {
          this.audio.play('hurt')
          this.cam.addShake(0.12)
          const from = e.a ? this.posOf(s, e.a) : null
          if (from) {
            const b = s.me.body
            const dx = from.x - b.x
            const dz = from.z - b.z
            const yaw = this.cam.yaw
            const fwd = dx * -Math.sin(yaw) + dz * -Math.cos(yaw)
            const right = dx * Math.cos(yaw) + dz * -Math.sin(yaw)
            this.hooks.damage(Math.atan2(right, fwd))
          } else this.hooks.damage(Number.NaN)
        }
        break
      }
      case 'kill': {
        const weapon = findWeapon(e.w)?.name ?? (e.w in GRENADES ? GRENADES[e.w as keyof typeof GRENADES].name : e.w === 'fall' ? 'The void' : e.w.toUpperCase())
        const victimDummy = e.v.startsWith('dummy:')
        if (!victimDummy || e.k === me) {
          this.hooks.feed({
            killer: e.k ? s.nameOf(e.k) : '', killerTeam: e.k ? s.teamOf(e.k) : 0,
            victim: s.nameOf(e.v), victimTeam: s.teamOf(e.v), weapon, head: e.head, mine: e.k === me, me: e.v === me,
          })
        }
        if (e.v === me) {
          this.deathReason = e.k && e.k !== me ? `Eliminated by ${s.nameOf(e.k)} (${weapon})` : e.w === 'fall' ? 'You fell into the void' : 'You were taken out'
          this.hooks.death(true, this.deathReason)
        }
        break
      }
      case 'throw': {
        const p = this.posOf(s, e.p)
        if (p && e.p !== me) this.audio.play('throw', this.volumeAt(p.x, p.y, p.z) * 0.8)
        break
      }
      case 'boom': {
        this.world.explosion(e.x, e.y, e.z, e.r, e.k)
        const vol = this.volumeAt(e.x, e.y, e.z)
        this.audio.play('boom', vol)
        const c = this.cam.camera.position
        const d = Math.hypot(c.x - e.x, c.y - e.y, c.z - e.z)
        if (d < 28) this.cam.addShake(0.4 * (1 - d / 28))
        break
      }
      case 'gas':
        this.world.gasBurst(e.x, e.y, e.z, e.r)
        this.audio.play('gas', this.volumeAt(e.x, e.y, e.z))
        break
      case 'armed': {
        const g = s.grenades(performance.now()).find(x => x.i === e.id)
        this.audio.play('armed', g ? this.volumeAt(g.x, g.y, g.z) : 0.4)
        break
      }
      case 'pickup': {
        const def = findWeapon(e.w)
        const sp = ARENA.pickups[e.spot]
        if (e.p === me) {
          this.audio.play('pickup')
          this.hooks.banner(`Picked up ${def?.name ?? e.w}`)
          if (def) this.avatar.selectWeapon(s.me.loadout.weapon.def.id)
        } else if (sp) this.audio.play('pickup', this.volumeAt(sp.x, sp.y, sp.z) * 0.5)
        break
      }
      case 'item': {
        const sp = ARENA.pickups[e.spot]
        if (sp) this.audio.play('item', this.volumeAt(sp.x, sp.y, sp.z) * 0.6)
        break
      }
      case 'reload': {
        if (e.p !== me) { const p = this.posOf(s, e.p); if (p) this.audio.play('reload_out', this.volumeAt(p.x, p.y, p.z) * 0.5) }
        break
      }
      case 'emote': {
        if (e.p === me) { this.avatar.playEmote(); this.audio.play('emote') }
        else { const p = this.posOf(s, e.p); if (p) this.audio.play('emote', this.volumeAt(p.x, p.y, p.z) * 0.6) }
        break
      }
      case 'phase': {
        this.hooks.phase(e.ph, e.winner ?? -1)
        if (e.ph === 'results') {
          const winner = e.winner ?? -1
          const mine = s.info.team
          this.audio.play(winner === -1 || winner === mine ? 'win' : 'lose')
        }
        break
      }
      default: break
    }
  }

  // ---- HUD -----------------------------------------------------------------------------------
  hud(): HudInfo {
    const s = this.session
    if (!s) {
      return {
        health: 100, maxHealth: 100, fuel: 100, maxFuel: 100, thrusting: false, fuelLocked: false, weapon: '', weaponId: '', ammo: 0, clip: 0,
        reload: 0, spread: 0, dead: false, respawn: 0, deathReason: '', protect: false, grenades: [], grenadeSelected: 0, grenadeCooldown: 0,
        pickupNear: '', phase: 'live', timeLeft: 0, scores: [0, 0], killLimit: 0, practice: true, team: 0, ping: 0,
      }
    }
    const me = s.me
    const w = me.loadout.weapon
    const def = w.def
    const move = Math.min(1, Math.hypot(me.body.vx, me.body.vz) / CONFIG.player.sprintSpeed)
    const spread = def.spread + def.spreadMove * move + (me.grounded ? 0 : def.spreadAir)
    return {
      health: s.info.health, maxHealth: CONFIG.player.maxHealth,
      fuel: me.jet.fuel, maxFuel: CONFIG.jetpack.maxFuel, thrusting: me.jet.thrusting, fuelLocked: me.jet.locked,
      weapon: def.name, weaponId: def.id, ammo: w.ammo, clip: def.clip,
      reload: me.loadout.reloading ? 1 - me.loadout.reloadLeft / def.reload : 0,
      spread, dead: s.info.dead, respawn: Math.max(0, s.info.respawnLeft), deathReason: this.deathReason, protect: s.info.protect,
      grenades: GRENADE_KINDS.map((k, i) => ({ name: GRENADES[k].name, key: GRENADES[k].key, color: GRENADES[k].color, count: me.gren.count[i], max: GRENADES[k].maxCount })),
      grenadeSelected: me.gren.selected, grenadeCooldown: me.gren.cooldown,
      pickupNear: this.pickupNear,
      phase: s.match.phase, timeLeft: s.match.timeLeft, scores: s.match.scores, killLimit: s.match.killLimit,
      practice: s.match.practice, team: s.info.team, ping: Math.round(s.rtt),
    }
  }

  scoreboard(): ScoreRow[] { return this.session?.scoreboard() ?? [] }
  get playerName(): string { return this.ownName }

  /** Debug/test helper: apply damage by sending the player into the void (practice only). */
  get state(): { x: number; y: number; z: number } | null {
    const b = this.session?.me.body
    return b ? { x: b.x, y: b.y, z: b.z } : null
  }
}

