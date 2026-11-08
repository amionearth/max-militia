/**
 * Third-person over-the-shoulder camera. Mouse look sets yaw/pitch immediately (so aiming feels
 * direct); only the camera position is smoothed. A ray from the head to the desired position
 * shortens the distance so walls never block the view. The crosshair is the screen centre.
 */
import * as THREE from 'three'
import type { CollisionWorld } from './collision'
import { CONFIG } from './config'

export class ThirdPersonCamera {
  readonly camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 16 / 9, 0.1, 600)
  yaw = 0
  pitch = 0.12
  /** Head position the camera orbits (updated each frame). */
  readonly pivot = new THREE.Vector3()
  readonly forward = new THREE.Vector3(0, 0, -1)
  private readonly smoothed = new THREE.Vector3()
  private readonly dir = new THREE.Vector3()
  private shake = 0
  private appliedFov = CONFIG.camera.fov
  private initialised = false

  constructor(private readonly world: CollisionWorld) {}

  addShake(amount: number): void {
    this.shake = Math.min(0.5, this.shake + amount)
  }

  /** Snap to the target without smoothing (spawn / respawn). */
  reset(): void {
    this.initialised = false
  }

  update(feet: THREE.Vector3, look: { x: number; y: number }, dt: number, reducedMotion = false): void {
    const cfg = CONFIG.camera
    this.yaw -= look.x
    this.pitch = THREE.MathUtils.clamp(this.pitch - look.y, cfg.minPitch, cfg.maxPitch)

    const cp = Math.cos(this.pitch)
    this.forward.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp)
    const rx = Math.cos(this.yaw)
    const rz = -Math.sin(this.yaw)

    this.pivot.set(feet.x, feet.y + cfg.height, feet.z)
    const desired = new THREE.Vector3(
      this.pivot.x - this.forward.x * cfg.distance + rx * cfg.shoulder,
      this.pivot.y - this.forward.y * cfg.distance + 0.2,
      this.pivot.z - this.forward.z * cfg.distance + rz * cfg.shoulder,
    )
    if (!this.initialised) { this.smoothed.copy(desired); this.initialised = true }
    else this.smoothed.lerp(desired, 1 - Math.exp(-cfg.follow * dt))

    // Keep the camera outside walls: shorten the pivot -> camera segment at the first hit.
    this.dir.copy(this.smoothed).sub(this.pivot)
    const length = this.dir.length()
    const position = this.smoothed.clone()
    if (length > 0.001) {
      this.dir.divideScalar(length)
      const hit = this.world.raycast(this.pivot.x, this.pivot.y, this.pivot.z, this.dir.x, this.dir.y, this.dir.z, length + 0.3)
      if (hit && hit.t < length + 0.3) {
        const safe = Math.max(0.35, hit.t - 0.3)
        position.copy(this.pivot).addScaledVector(this.dir, safe)
        this.smoothed.copy(position)
      }
    }

    if (this.shake > 0.001 && !reducedMotion) {
      position.x += (Math.random() - 0.5) * this.shake * 0.35
      position.y += (Math.random() - 0.5) * this.shake * 0.35
    }
    this.shake *= Math.exp(-9 * dt)

    this.camera.position.copy(position)
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
    if (this.appliedFov !== cfg.fov) {
      this.appliedFov = cfg.fov
      this.camera.fov = cfg.fov
      this.camera.updateProjectionMatrix()
    }
  }
}
