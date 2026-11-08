/**
 * The practice dummy as a pure view: all hit detection and health live in the shared MatchSim.
 * This class only draws the target, flashes on damage, topples when destroyed and pops back up.
 */
import * as THREE from 'three'
import type { DummySpec } from '../shared/arenaData'

export class DummyView {
  readonly root = new THREE.Group()
  private readonly pivot = new THREE.Group()
  private readonly bodyMat: THREE.MeshStandardMaterial
  private readonly barRoot = new THREE.Group()
  private readonly barFill: THREE.Mesh
  private hp: number
  private alive = true
  private flash = 0
  private fall = 0
  private pop = 1

  constructor(readonly spec: DummySpec) {
    this.hp = spec.hp
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0xff8a1f, emissive: 0x401800, roughness: 0.6 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x222844, roughness: 0.7 })
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.58, 0.12, 10), dark)
    base.position.y = 0.06
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 6), dark)
    post.position.y = 0.37
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.95, 0.34), this.bodyMat)
    torso.position.y = 1.0
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), new THREE.MeshBasicMaterial({ map: targetTexture() }))
    face.position.set(0, 1.02, -0.175)
    face.rotation.y = Math.PI
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), this.bodyMat)
    head.position.y = 1.72
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.025, 6, 16), new THREE.MeshBasicMaterial({ color: 0xff3b5c }))
    ring.position.y = 1.72
    ring.rotation.x = Math.PI / 2
    this.pivot.add(torso, face, head, ring, post)
    for (const m of [torso, head, base]) m.castShadow = true
    this.root.add(base, this.pivot)

    const back = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.12), new THREE.MeshBasicMaterial({ color: 0x120a24, transparent: true, opacity: 0.8, depthTest: false }))
    this.barFill = new THREE.Mesh(new THREE.PlaneGeometry(1.06, 0.08), new THREE.MeshBasicMaterial({ color: 0x4dff9a, depthTest: false }))
    this.barFill.position.z = 0.001
    back.renderOrder = this.barFill.renderOrder = 10
    this.barRoot.add(back, this.barFill)
    this.barRoot.position.y = 2.35
    this.root.add(this.barRoot)
    this.root.position.set(spec.x, spec.y, spec.z)
    this.root.rotation.y = spec.yaw
  }

  /** Mirror the simulation's state. */
  sync(hp: number, alive: boolean): void {
    if (hp < this.hp && alive) this.flash = 0.09
    if (!this.alive && alive) { this.pop = 0; this.fall = 0; this.pivot.rotation.x = 0; this.pivot.position.y = 0; this.pivot.visible = true }
    if (this.alive && !alive) this.flash = 0.12
    this.hp = hp
    this.alive = alive
  }

  update(dt: number, camera: THREE.Camera): void {
    if (!this.alive) {
      this.fall = Math.min(1, this.fall + dt * 3.2)
      this.pivot.rotation.x = this.fall * (Math.PI / 2)
      this.pivot.position.y = -this.fall * 0.4
    } else if (this.pop < 1) {
      this.pop = Math.min(1, this.pop + dt * 4)
      this.pivot.scale.setScalar(0.4 + 0.6 * this.pop)
    } else this.pivot.scale.setScalar(1)

    this.flash = Math.max(0, this.flash - dt)
    this.bodyMat.emissive.setHex(this.flash > 0 ? 0xffffff : 0x401800)
    const k = this.hp / this.spec.hp
    this.barFill.scale.x = Math.max(0.001, k)
    this.barFill.position.x = -(1 - k) * 0.53
    ;(this.barFill.material as THREE.MeshBasicMaterial).color.setHex(k > 0.5 ? 0x4dff9a : k > 0.25 ? 0xffd23f : 0xff3b5c)
    this.barRoot.visible = this.alive
    this.barRoot.quaternion.copy(camera.quaternion)
    this.barRoot.quaternion.premultiply(this.root.quaternion.clone().invert())
  }
}

function targetTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#f5f5ff'
  g.fillRect(0, 0, 128, 128)
  const rings = ['#ff3b5c', '#f5f5ff', '#ff3b5c', '#f5f5ff', '#ff3b5c']
  rings.forEach((color, i) => {
    g.fillStyle = color
    g.beginPath(); g.arc(64, 64, 60 - i * 12, 0, Math.PI * 2); g.fill()
  })
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
