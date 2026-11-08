/**
 * Visuals for the shared-world objects the server owns: live grenades, gas clouds, floating weapon
 * pickups and explosion flashes. Pure view code: it renders whatever the session reports.
 */
import * as THREE from 'three'
import { ARENA } from '../shared/arenaData'
import { GRENADES, grenadeKindAt } from '../shared/grenades'
import { findWeapon } from '../shared/weapons'
import type { GasSnap, GrenadeSnap } from '../shared/match'
import { ParticleSystem } from './fx'

const TIER_COLOR: Record<string, number> = { low: 0x22e6ff, mid: 0xffb020, high: 0xff2fb8 }

type Blast = { mesh: THREE.Mesh; ring: THREE.Mesh; life: number; max: number; r: number }
type PickupProp = { root: THREE.Group; crate: THREE.Mesh; label: THREE.Sprite | null; weapon: string; pop: number }

function labelSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas')
  c.width = 256; c.height = 64
  const g = c.getContext('2d')!
  g.font = 'bold 34px system-ui, sans-serif'
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.lineWidth = 7; g.strokeStyle = 'rgba(8,4,24,0.95)'
  g.strokeText(text, 128, 32)
  g.fillStyle = color
  g.fillText(text, 128, 32)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
  s.scale.set(2.2, 0.55, 1)
  s.position.y = 1.05
  s.renderOrder = 18
  return s
}

export class WorldFx {
  readonly group = new THREE.Group()
  readonly gasPuffs = new ParticleSystem(520, 1.5, 0.15)
  private readonly grenades = new Map<number, THREE.Group>()
  private readonly clouds = new Map<number, THREE.Mesh>()
  private readonly pickups: PickupProp[] = []
  private readonly blasts: Blast[] = []
  private time = 0
  private readonly gasColor = new THREE.Color('#6dff8a')

  constructor(private readonly sparks: ParticleSystem) {
    this.group.add(this.gasPuffs.points)
    ARENA.pickups.forEach((spot) => {
      const root = new THREE.Group()
      const color = TIER_COLOR[spot.tier] ?? 0x22e6ff
      const crate = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.38, 0.9),
        new THREE.MeshStandardMaterial({ color: 0x2a2f55, emissive: color, emissiveIntensity: 0.55, roughness: 0.4, metalness: 0.4 }),
      )
      crate.add(new THREE.LineSegments(new THREE.EdgesGeometry(crate.geometry), new THREE.LineBasicMaterial({ color })))
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.35, 3, 8, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      )
      beam.position.y = 1.5
      root.add(crate, beam)
      root.position.set(spot.x, spot.y, spot.z)
      root.visible = false
      this.group.add(root)
      this.pickups.push({ root, crate, label: null, weapon: '', pop: 0 })
    })
  }

  /** `weapons[i]` is the weapon id on spot i, or '' when empty. */
  syncPickups(weapons: readonly string[]): void {
    weapons.forEach((w, i) => {
      const p = this.pickups[i]
      if (!p) return
      if (w === p.weapon) return
      if (p.label) { p.root.remove(p.label); (p.label.material as THREE.SpriteMaterial).map?.dispose(); p.label.material.dispose(); p.label = null }
      p.weapon = w
      p.root.visible = w !== ''
      if (w) {
        const def = findWeapon(w)
        const tier = ARENA.pickups[i].tier
        p.label = labelSprite(def?.name ?? w.toUpperCase(), '#' + (TIER_COLOR[tier] ?? 0x22e6ff).toString(16).padStart(6, '0'))
        p.root.add(p.label)
        p.pop = 0
      }
    })
  }

  syncGrenades(list: readonly GrenadeSnap[]): void {
    const seen = new Set<number>()
    for (const g of list) {
      seen.add(g.i)
      let mesh = this.grenades.get(g.i)
      if (!mesh) {
        mesh = this.makeGrenade(g.k)
        this.grenades.set(g.i, mesh)
        this.group.add(mesh)
      }
      mesh.position.set(g.x, g.y + 0.1, g.z)
      mesh.rotation.y = this.time * 3 + g.i
      const led = mesh.userData.led as THREE.Mesh | undefined
      if (led) {
        const mat = led.material as THREE.MeshBasicMaterial
        const kind = grenadeKindAt(g.k)
        if (kind === 'prox') {
          // Landed: slow blink. Armed: fast blink. Triggered: solid.
          const blink = g.s === 3 ? 1 : g.s === 2 ? (Math.sin(this.time * 14) > 0 ? 1 : 0.15) : g.s === 1 ? (Math.sin(this.time * 5) > 0 ? 0.8 : 0.15) : 0.4
          mat.color.setRGB(blink, blink * (g.s === 3 ? 0.1 : 0.2), blink * 0.2)
        } else {
          // Fuse flicker speeds up towards the end for frag and gas.
          const rate = 6 + (2.5 - Math.min(2.5, g.f)) * 8
          const on = Math.sin(this.time * rate) > -0.2
          mat.color.setRGB(on ? 1 : 0.2, on ? 0.2 : 0.05, 0.1)
        }
      }
    }
    for (const [id, mesh] of this.grenades) {
      if (!seen.has(id)) {
        this.group.remove(mesh)
        mesh.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose() } })
        this.grenades.delete(id)
      }
    }
  }

  private makeGrenade(kindIndex: number): THREE.Group {
    const kind = grenadeKindAt(kindIndex)
    const def = GRENADES[kind]
    const g = new THREE.Group()
    const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(def.color).multiplyScalar(0.5), roughness: 0.5, metalness: 0.4, emissive: new THREE.Color(def.color), emissiveIntensity: 0.25 })
    let body: THREE.Mesh
    if (kind === 'frag') body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 1), bodyMat)
    else if (kind === 'gas') body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.34, 10), bodyMat)
    else body = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.1, 12), bodyMat)
    body.castShadow = true
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff3030 }))
    led.position.y = kind === 'prox' ? 0.07 : 0.18
    g.add(body, led)
    g.userData.led = led
    return g
  }

  syncClouds(list: readonly GasSnap[], dt: number): void {
    const seen = new Set<number>()
    for (const c of list) {
      seen.add(c.i)
      let mesh = this.clouds.get(c.i)
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.IcosahedronGeometry(1, 1),
          new THREE.MeshBasicMaterial({ color: 0x4dff7a, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending }),
        )
        this.clouds.set(c.i, mesh)
        this.group.add(mesh)
      }
      const grow = Math.min(1, (c.l > 0 ? 1 : 0) * 1)
      mesh.position.set(c.x, c.y + c.r * 0.35, c.z)
      mesh.scale.setScalar(c.r * (0.85 + Math.sin(this.time * 2 + c.i) * 0.04) * grow)
      ;(mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(0.14, c.l * 0.05)
      // Drifting puffs fill the volume.
      const n = Math.max(1, Math.round(dt * 60 * 0.9))
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        const rr = Math.sqrt(Math.random()) * c.r * 0.9
        this.gasPuffs.emit(c.x + Math.cos(a) * rr, c.y + 0.1 + Math.random() * c.r * 0.5, c.z + Math.sin(a) * rr, (Math.random() - 0.5) * 0.6, 0.2 + Math.random() * 0.4, (Math.random() - 0.5) * 0.6, this.gasColor, 1.4 + Math.random() * 0.8)
      }
    }
    for (const [id, mesh] of this.clouds) {
      if (!seen.has(id)) {
        this.group.remove(mesh)
        mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose()
        this.clouds.delete(id)
      }
    }
  }

  explosion(x: number, y: number, z: number, radius: number, kind: number): void {
    const color = kind === 2 ? 0xff3b5c : 0xffa23a
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 32),
      new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    mesh.position.set(x, y, z)
    ring.position.set(x, y + 0.05, z)
    this.group.add(mesh, ring)
    this.blasts.push({ mesh, ring, life: 0.45, max: 0.45, r: radius })
    const c = new THREE.Color(color)
    for (let i = 0; i < 40; i++) {
      const s = 3 + Math.random() * 9
      const a = Math.random() * Math.PI * 2
      const e = (Math.random() - 0.3) * 1.4
      this.sparks.emit(x, y, z, Math.cos(a) * s, 2 + e * s * 0.6, Math.sin(a) * s, c, 0.4 + Math.random() * 0.5)
    }
  }

  gasBurst(x: number, y: number, z: number, radius: number): void {
    for (let i = 0; i < 50; i++) {
      const a = Math.random() * Math.PI * 2
      const s = 1 + Math.random() * 3
      this.gasPuffs.emit(x, y + 0.3, z, Math.cos(a) * s, Math.random() * 1.5, Math.sin(a) * s, this.gasColor, 0.8 + Math.random() * 0.8)
    }
    void radius
  }

  update(dt: number): void {
    this.time += dt
    this.gasPuffs.update(dt)
    for (const p of this.pickups) {
      if (!p.root.visible) continue
      p.pop = Math.min(1, p.pop + dt * 3)
      p.crate.rotation.y = this.time * 1.6
      p.crate.position.y = 0.55 + Math.sin(this.time * 2.4) * 0.1
      p.crate.scale.setScalar(0.3 + 0.7 * p.pop)
    }
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i]
      b.life -= dt
      const k = 1 - b.life / b.max
      if (b.life <= 0) {
        this.group.remove(b.mesh, b.ring)
        b.mesh.geometry.dispose(); (b.mesh.material as THREE.Material).dispose()
        b.ring.geometry.dispose(); (b.ring.material as THREE.Material).dispose()
        this.blasts.splice(i, 1)
        continue
      }
      b.mesh.scale.setScalar(b.r * 0.55 * (0.3 + 0.7 * Math.sqrt(k)))
      ;(b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k)
      b.ring.scale.setScalar(b.r * (0.2 + 0.8 * k))
      ;(b.ring.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k)
    }
  }
}
