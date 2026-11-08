/**
 * Cheap pooled effects: a point-sprite particle system (sparks, flame, smoke) and a pool of
 * bullet tracers. No allocations per shot, no lights, additive blending only.
 */
import * as THREE from 'three'

let spriteTexture: THREE.CanvasTexture | null = null
/** One shared soft round sprite, drawn procedurally (no image assets). */
function softSprite(): THREE.CanvasTexture {
  if (spriteTexture) return spriteTexture
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.7)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  spriteTexture = new THREE.CanvasTexture(c)
  return spriteTexture
}

export class ParticleSystem {
  readonly points: THREE.Points
  private readonly positions: Float32Array
  private readonly colors: Float32Array
  private readonly base: Float32Array
  private readonly vel: Float32Array
  private readonly life: Float32Array
  private readonly maxLife: Float32Array
  private cursor = 0

  constructor(private readonly capacity: number, size: number, private readonly gravity: number) {
    this.positions = new Float32Array(capacity * 3).fill(0)
    this.colors = new Float32Array(capacity * 3)
    this.base = new Float32Array(capacity * 3)
    this.vel = new Float32Array(capacity * 3)
    this.life = new Float32Array(capacity)
    this.maxLife = new Float32Array(capacity).fill(1)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3))
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
      map: softSprite(),
    }))
    this.points.frustumCulled = false
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: THREE.Color, life: number): void {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.capacity
    this.positions.set([x, y, z], i * 3)
    this.vel.set([vx, vy, vz], i * 3)
    this.base.set([color.r, color.g, color.b], i * 3)
    this.life[i] = life
    this.maxLife[i] = life
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) { this.colors[i * 3] = this.colors[i * 3 + 1] = this.colors[i * 3 + 2] = 0; continue }
      this.life[i] -= dt
      const k = Math.max(0, this.life[i] / this.maxLife[i])
      this.vel[i * 3 + 1] += this.gravity * dt
      for (let a = 0; a < 3; a++) {
        this.positions[i * 3 + a] += this.vel[i * 3 + a] * dt
        this.colors[i * 3 + a] = this.base[i * 3 + a] * k
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true
    this.points.geometry.attributes.color.needsUpdate = true
  }

  clear(): void {
    this.life.fill(0)
    this.colors.fill(0)
    this.points.geometry.attributes.color.needsUpdate = true
  }
}

type Tracer = { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; maxLife: number }

export class Tracers {
  readonly group = new THREE.Group()
  private readonly pool: Tracer[] = []
  private cursor = 0
  private readonly geo = new THREE.BoxGeometry(1, 1, 1)

  constructor(count = 40) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
      const mesh = new THREE.Mesh(this.geo, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.pool.push({ mesh, mat, life: 0, maxLife: 0.08 })
    }
  }

  spawn(from: THREE.Vector3, to: THREE.Vector3, color: string, width = 0.035): void {
    const t = this.pool[this.cursor]
    this.cursor = (this.cursor + 1) % this.pool.length
    const len = from.distanceTo(to)
    if (len < 0.05) return
    t.mesh.position.copy(from).add(to).multiplyScalar(0.5)
    t.mesh.lookAt(to)
    t.mesh.scale.set(width, width, len)
    t.mat.color.set(color)
    t.mat.opacity = 1
    t.mesh.visible = true
    t.life = t.maxLife = 0.09
  }

  update(dt: number): void {
    for (const t of this.pool) {
      if (!t.mesh.visible) continue
      t.life -= dt
      if (t.life <= 0) { t.mesh.visible = false; continue }
      t.mat.opacity = t.life / t.maxLife
    }
  }
}
