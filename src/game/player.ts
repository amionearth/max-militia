/**
 * Player simulation (no rendering). Fixed-step movement against the collision world, jump,
 * jetpack, health and level bounds. The avatar mesh only mirrors this state.
 */
import { CollisionWorld, type Body } from './collision'
import { CONFIG } from './config'
import { createJet, stepJet, type JetState } from './jetpack'
import { tuning } from './tuning'

export type Intent = { moveX: number; moveY: number; sprint: boolean; jumpPressed: boolean; jumpHeld: boolean }
export type PlayerEvent = { type: 'jump' } | { type: 'land'; impact: number } | { type: 'fell' }
export type Bounds = { x: number; z: number; ceiling: number; killY: number }

export class Player {
  readonly body: Body = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }
  /** Position at the start of the latest step, for render interpolation. */
  readonly prev = { x: 0, y: 0, z: 0 }
  readonly jet: JetState = createJet(CONFIG.jetpack.maxFuel)
  grounded = false
  health: number = CONFIG.player.maxHealth
  dead = false
  /** Seconds left until respawn while dead. */
  respawnLeft = 0
  /** Heading the avatar faces (radians); follows the camera. */
  facing = 0
  private airTime = 0
  private coyote = 0

  constructor(private readonly world: CollisionWorld, private readonly bounds: Bounds) {}

  get horizontalSpeed(): number {
    return Math.hypot(this.body.vx, this.body.vz)
  }

  spawn(x: number, y: number, z: number, yaw: number): void {
    Object.assign(this.body, { x, y, z, vx: 0, vy: 0, vz: 0 })
    Object.assign(this.prev, { x, y, z })
    this.jet.fuel = CONFIG.jetpack.maxFuel
    this.jet.idle = 99
    this.jet.hold = 0
    this.jet.locked = false
    this.jet.thrusting = false
    this.health = CONFIG.player.maxHealth
    this.dead = false
    this.respawnLeft = 0
    this.grounded = false
    this.airTime = 0
    this.coyote = 0
    this.facing = yaw
  }

  /** Returns true if this damage killed the player. */
  damage(amount: number): boolean {
    if (this.dead) return false
    this.health = Math.max(0, this.health - amount)
    return this.health <= 0
  }

  die(): void {
    this.dead = true
    this.health = 0
    this.respawnLeft = CONFIG.player.respawnSeconds
    this.jet.thrusting = false
    this.body.vx = this.body.vz = 0
  }

  step(dt: number, intent: Intent, cameraYaw: number, events: PlayerEvent[]): void {
    const c = CONFIG.player
    const j = CONFIG.jetpack
    const b = this.body
    this.prev.x = b.x
    this.prev.y = b.y
    this.prev.z = b.z

    // Horizontal movement relative to the camera heading.
    const fx = -Math.sin(cameraYaw)
    const fz = -Math.cos(cameraYaw)
    const rx = Math.cos(cameraYaw)
    const rz = -Math.sin(cameraYaw)
    let wx = fx * intent.moveY + rx * intent.moveX
    let wz = fz * intent.moveY + rz * intent.moveX
    const len = Math.hypot(wx, wz)
    if (len > 1) { wx /= len; wz /= len }
    const speed = (intent.sprint ? c.sprintSpeed : c.walkSpeed) * (this.jet.thrusting ? j.airSpeedBoost : 1)
    const dvx = wx * speed - b.vx
    const dvz = wz * speed - b.vz
    const dv = Math.hypot(dvx, dvz)
    const maxDv = c.acceleration * (this.grounded ? 1 : c.airControl) * dt
    if (dv <= maxDv || dv === 0) { b.vx = wx * speed; b.vz = wz * speed }
    else { b.vx += (dvx / dv) * maxDv; b.vz += (dvz / dv) * maxDv }

    // Jump (with a little coyote time) and jetpack.
    this.coyote = this.grounded ? c.coyoteTime : Math.max(0, this.coyote - dt)
    this.airTime = this.grounded ? 0 : this.airTime + dt
    if (intent.jumpPressed && this.coyote > 0) {
      tuning.activate('jump')
      b.vy = c.jumpSpeed
      this.coyote = 0
      this.grounded = false
      this.airTime = 0
      events.push({ type: 'jump' })
    }
    const wantThrust = intent.jumpHeld && !this.grounded && this.airTime >= j.startDelay
    const thrust = stepJet(this.jet, wantThrust, this.grounded, dt, j)
    b.vy += (c.gravity + thrust) * dt
    if (this.jet.thrusting && b.vy > j.maxRiseSpeed) b.vy = j.maxRiseSpeed
    if (b.vy < c.maxFall) b.vy = c.maxFall

    const wasGrounded = this.grounded
    const result = this.world.moveBody(b, c.radius, c.height, dt)
    this.grounded = result.grounded
    if (result.grounded && !wasGrounded && result.impact > 6) events.push({ type: 'land', impact: result.impact })

    // Invisible walls and ceiling.
    const limX = this.bounds.x - c.radius
    const limZ = this.bounds.z - c.radius
    if (b.x > limX) { b.x = limX; b.vx = Math.min(b.vx, 0) }
    if (b.x < -limX) { b.x = -limX; b.vx = Math.max(b.vx, 0) }
    if (b.z > limZ) { b.z = limZ; b.vz = Math.min(b.vz, 0) }
    if (b.z < -limZ) { b.z = -limZ; b.vz = Math.max(b.vz, 0) }
    if (b.y + c.height > this.bounds.ceiling) { b.y = this.bounds.ceiling - c.height; b.vy = Math.min(b.vy, 0) }
    if (b.y < this.bounds.killY) events.push({ type: 'fell' })
  }
}
