/**
 * The soldier: a chibi base body built only from primitives (round head, capsule torso, box limbs,
 * backpack jetpack) with swappable cosmetics layered on top. Cosmetics are plain ids from
 * shared/cosmetics; this class turns ids into meshes. Animation is procedural (idle bob, run swing,
 * jetpack hover pose, wave/salute emotes). The avatar never owns gameplay state.
 */
import * as THREE from 'three'
import { optionOf, type Cosmetics } from '../shared/cosmetics'

export type AvatarPose = {
  /** Horizontal speed, 0..1 of sprint speed. */
  speed: number
  grounded: boolean
  /** Smoothed jetpack thrust, 0..1. */
  thrust: number
  /** Aim pitch in radians (positive = up). */
  pitch: number
  weaponId: string
  emote?: boolean
}

export const TEAM_COLORS = [0xff3b5c, 0x3b8cff] as const
const PIVOT_SHOULDER_Y = 1.45
type GunRec = { group: THREE.Group; muzzle: THREE.Object3D; twoHand: boolean }

function mat(color: number | string, rough = 0.65, metal = 0.15): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal })
}
function glowMat(color: number | string): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color })
}
function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
  mesh.position.set(x, y, z)
  return mesh
}
function cyl(rt: number, rb: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 8): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m)
  mesh.position.set(x, y, z)
  return mesh
}

function camoTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = '#4c6b3c'
  g.fillRect(0, 0, 64, 64)
  const blots = ['#2f4a2a', '#6a8a52', '#3a5a32']
  for (let i = 0; i < 14; i++) {
    g.fillStyle = blots[i % blots.length]
    g.beginPath()
    g.ellipse((i * 23) % 64, (i * 37) % 64, 9 + (i % 3) * 3, 6 + (i % 4) * 2, i, 0, Math.PI * 2)
    g.fill()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function faceTexture(kind: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.clearRect(0, 0, 64, 64)
  if (kind === 'skull_mask') {
    g.fillStyle = '#e8e8f4'
    g.beginPath(); g.ellipse(32, 30, 22, 24, 0, 0, Math.PI * 2); g.fill()
    g.fillRect(18, 44, 28, 14)
    g.fillStyle = '#15121f'
    g.beginPath(); g.ellipse(22, 28, 6, 7, 0, 0, Math.PI * 2); g.ellipse(42, 28, 6, 7, 0, 0, Math.PI * 2); g.fill()
    g.beginPath(); g.moveTo(32, 36); g.lineTo(28, 44); g.lineTo(36, 44); g.fill()
    for (let x = 22; x <= 42; x += 5) g.fillRect(x, 48, 2, 8)
  } else {
    g.fillStyle = '#15121f'
    g.beginPath(); g.ellipse(23, 30, 4.5, 6, 0, 0, Math.PI * 2); g.ellipse(41, 30, 4.5, 6, 0, 0, Math.PI * 2); g.fill()
    g.fillStyle = '#ffffff'
    g.beginPath(); g.arc(24.5, 28, 1.6, 0, Math.PI * 2); g.arc(42.5, 28, 1.6, 0, Math.PI * 2); g.fill()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse(n => {
    const m = n as THREE.Mesh
    if (m.isMesh) {
      m.geometry.dispose()
      const mm = m.material as THREE.Material | THREE.Material[]
      for (const x of Array.isArray(mm) ? mm : [mm]) {
        ;(x as THREE.MeshBasicMaterial).map?.dispose()
        x.dispose()
      }
    }
  })
}

export class Avatar {
  readonly root = new THREE.Group()
  private model = new THREE.Group()
  private legL = new THREE.Group()
  private legR = new THREE.Group()
  private armL = new THREE.Group()
  private armR = new THREE.Group()
  private guns = new Map<string, GunRec>()
  private flames: THREE.Mesh[] = []
  private flash!: THREE.Mesh
  private label: THREE.Sprite | null = null
  private labelSpec: { text: string; color: string; through: boolean } | null = null
  private shield: THREE.Mesh | null = null
  private phase = 0
  private flashLeft = 0
  private activeMuzzle: THREE.Object3D | null = null
  private lean = 0
  private legPose = 0
  private weaponId = 'uzi'
  private emoteMode = 'none'
  private emoteT = 0
  private emoteBlend = 0
  private shortSleeves = false

  constructor(private cosmetics: Cosmetics, private teamColor: number = TEAM_COLORS[0]) {
    this.build()
  }

  setTeamColor(color: number): void {
    if (color === this.teamColor) return
    this.teamColor = color
    this.build()
  }

  setCosmetics(c: Cosmetics): void {
    if (JSON.stringify(c) === JSON.stringify(this.cosmetics)) return
    this.cosmetics = c
    this.build()
  }

  /** Fire a one-shot emote animation using the equipped emote. */
  playEmote(): void {
    if (this.cosmetics.emote === 'none') return
    this.emoteMode = this.cosmetics.emote
    this.emoteT = 2
  }

  private build(): void {
    for (const o of [...this.root.children]) { this.root.remove(o); disposeTree(o) }
    this.model = new THREE.Group()
    this.legL = new THREE.Group(); this.legR = new THREE.Group()
    this.armL = new THREE.Group(); this.armR = new THREE.Group()
    this.guns = new Map(); this.flames = []
    this.label = null; this.shield = null

    const c = this.cosmetics
    const skin = mat(optionOf('skin', c.skin).color ?? '#d9cbc0', 0.8, 0.02)
    const team = mat(this.teamColor, 0.6, 0.1)
    const teamGlow = glowMat(this.teamColor)
    const dark = mat(0x3c4680)
    const black = mat(0x14141c, 0.7, 0.1)
    const flame = optionOf('jetpack_flame', c.jetpack_flame)
    const bootOpt = optionOf('boots', c.boots)
    const legOpt = optionOf('legs', c.legs)
    const torsoOpt = optionOf('torso', c.torso)

    let torsoMat: THREE.Material = team
    if (c.torso === 'camo_vest') torsoMat = new THREE.MeshStandardMaterial({ map: camoTexture(), roughness: 0.8 })
    else if (c.torso === 'hoodie') torsoMat = mat(torsoOpt.color ?? '#5b5f7a', 0.9, 0.02)
    else if (c.torso === 'armor_plate') torsoMat = mat(torsoOpt.color ?? '#39405e', 0.45, 0.45)
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.5, 4, 10), torsoMat)
    torso.position.y = 1.18
    torso.scale.z = 0.8
    this.model.add(torso)
    if (c.torso === 'camo_vest') this.model.add(box(0.62, 0.2, 0.42, team, 0, 1.0, 0))
    if (c.torso === 'hoodie') {
      this.model.add(box(0.36, 0.16, 0.04, mat(0x474a63), 0, 1.0, -0.22))
      const hood = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), torsoMat)
      hood.position.set(0, 1.55, 0.16)
      hood.rotation.x = 0.2
      this.model.add(hood)
    }
    if (c.torso === 'armor_plate') {
      this.model.add(box(0.4, 0.4, 0.06, teamGlow, 0, 1.28, -0.2))
      this.model.add(box(0.5, 0.1, 0.34, mat(0x2a304a, 0.4, 0.5), 0, 1.5, 0))
    }
    this.model.add(box(0.56, 0.07, 0.4, glowMat(0x14141c), 0, 0.95, 0))
    this.model.add(box(0.12, 0.08, 0.02, teamGlow, 0, 0.95, -0.205))
    this.shortSleeves = c.torso === 'tee'

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), skin)
    head.position.y = 1.78
    this.model.add(head, cyl(0.09, 0.1, 0.1, skin, 0, 1.58, 0))
    if (c.face !== 'visor' && c.face !== 'gas_mask') {
      const eyes = new THREE.Mesh(
        new THREE.PlaneGeometry(0.34, 0.34),
        new THREE.MeshBasicMaterial({ map: faceTexture(c.face === 'skull_mask' ? 'skull_mask' : 'eyes'), transparent: true }),
      )
      eyes.position.set(0, 1.78, -0.255)
      eyes.rotation.y = Math.PI
      this.model.add(eyes)
    }
    if (c.face === 'visor') {
      this.model.add(box(0.4, 0.12, 0.12, glowMat(optionOf('face', 'visor').color ?? '#59f3ff'), 0, 1.8, -0.2))
    } else if (c.face === 'gas_mask') {
      const maskMat = mat(optionOf('face', 'gas_mask').color ?? '#3d4462', 0.6, 0.2)
      const snout = cyl(0.1, 0.13, 0.2, maskMat, 0, 1.73, -0.28, 8)
      snout.rotation.x = Math.PI / 2
      this.model.add(snout, box(0.4, 0.1, 0.1, glowMat(0xff8a2a), 0, 1.82, -0.21))
      for (const s of [-1, 1]) { const f = cyl(0.05, 0.05, 0.08, black, s * 0.15, 1.69, -0.25, 8); f.rotation.x = Math.PI / 2; this.model.add(f) }
    }
    const headLayers: Record<string, () => void> = {
      cap: () => {
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.275, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), team)
        cap.position.y = 1.8
        cap.scale.set(1, 0.7, 1)
        this.model.add(cap, box(0.34, 0.03, 0.2, team, 0, 1.84, -0.28))
      },
      helmet: () => {
        const h = new THREE.Mesh(new THREE.SphereGeometry(0.29, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.58), mat(optionOf('head', 'helmet').color ?? '#4f5a8a', 0.5, 0.35))
        h.position.y = 1.8
        this.model.add(h, box(0.04, 0.05, 0.5, teamGlow, 0, 2.08, 0))
      },
      bandana: () => {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.275, 0.275, 0.1, 14, 1, true), team)
        band.position.y = 1.9
        this.model.add(band, box(0.1, 0.16, 0.06, team, 0.22, 1.86, 0.2))
      },
      goggles: () => {
        const strap = new THREE.Mesh(new THREE.CylinderGeometry(0.268, 0.268, 0.07, 14, 1, true), black)
        strap.position.y = 1.9
        const lens = glowMat(optionOf('head', 'goggles').color ?? '#22e6ff')
        this.model.add(strap, box(0.13, 0.1, 0.05, lens, -0.1, 1.9, -0.27), box(0.13, 0.1, 0.05, lens, 0.1, 1.9, -0.27))
      },
    }
    headLayers[c.head]?.()

    this.model.add(box(0.4, 0.56, 0.22, dark, 0, 1.22, 0.3), box(0.42, 0.05, 0.24, teamGlow, 0, 1.44, 0.3))
    for (const side of [-1, 1]) {
      this.model.add(cyl(0.07, 0.09, 0.16, mat(0x7284cf), side * 0.1, 0.88, 0.3))
      const f = new THREE.Mesh(
        new THREE.ConeGeometry(0.1, 0.8, 8, 1, true),
        new THREE.MeshBasicMaterial({ color: flame.color ?? '#ff8a2a', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      )
      f.rotation.x = Math.PI
      f.position.set(side * 0.1, 0.45, 0.3)
      const core = new THREE.Mesh(
        new THREE.ConeGeometry(0.05, 0.5, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: flame.core ?? '#fff3b0', transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      )
      core.position.y = -0.05
      f.add(core)
      f.visible = false
      this.flames.push(f)
      this.model.add(f)
    }

    const legMat = mat(legOpt.color ?? '#6f6a4a', 0.8, 0.05)
    for (const [leg, side] of [[this.legL, -1], [this.legR, 1]] as const) {
      leg.position.set(side * 0.15, 0.88, 0)
      if (c.legs === 'shorts') {
        leg.add(box(0.22, 0.34, 0.26, legMat, 0, -0.17, 0), box(0.16, 0.4, 0.2, skin, 0, -0.54, 0))
      } else {
        leg.add(box(0.2, 0.74, 0.24, legMat, 0, -0.37, 0))
        if (c.legs === 'cargo') leg.add(box(0.05, 0.2, 0.18, mat(0x57533a), side * 0.115, -0.3, 0))
        if (c.legs === 'armored') leg.add(box(0.24, 0.16, 0.08, mat(0x5a6390, 0.4, 0.5), 0, -0.45, -0.12))
      }
      const bootMat = c.boots === 'gold' ? mat(bootOpt.color ?? '#ffc83d', 0.35, 0.7) : black
      leg.add(box(0.24, 0.16, 0.36, bootMat, 0, -0.8, -0.05))
      if (c.boots === 'neon') leg.add(box(0.26, 0.03, 0.38, glowMat(bootOpt.color ?? '#22e6ff'), 0, -0.87, -0.05))
      this.model.add(leg)
    }

    for (const [arm, side] of [[this.armL, -1], [this.armR, 1]] as const) {
      arm.position.set(side * 0.36, PIVOT_SHOULDER_Y, 0)
      if (this.shortSleeves) arm.add(box(0.15, 0.2, 0.15, torsoMat, 0, -0.1, 0), box(0.12, 0.3, 0.12, skin, 0, -0.35, 0))
      else arm.add(box(0.15, 0.52, 0.15, torsoMat, 0, -0.26, 0))
      const glove = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6), black)
      glove.position.y = -0.54
      arm.add(glove)
      this.model.add(arm)
    }
    this.buildGuns(dark, glowMat(0x22e6ff))

    this.flash = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.1, 0),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    )
    this.flash.scale.set(1, 1.8, 1)
    this.flash.visible = false

    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0x7fe9ff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    this.shield.position.y = 1.0
    this.shield.visible = false

    this.root.add(this.model, this.shield)
    this.model.traverse(m => { if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).castShadow = true })
    this.selectWeapon(this.weaponId)
    if (this.labelSpec) this.setLabel(this.labelSpec.text, this.labelSpec.color, this.labelSpec.through)
  }

  private buildGuns(dark: THREE.Material, glow: THREE.Material): void {
    const mid = mat(0x7284cf, 0.5, 0.3)
    const wood = mat(0x7a4a2b, 0.8, 0.05)
    const steel = mat(0x9aa4c8, 0.35, 0.7)
    const gold = mat(0xffc83d, 0.35, 0.7)
    const add = (id: string, parts: THREE.Object3D[], muzzleY: number, twoHand: boolean) => {
      const group = new THREE.Group()
      for (const p of parts) group.add(p)
      const muzzle = new THREE.Object3D()
      muzzle.position.y = muzzleY
      group.add(muzzle)
      group.position.y = -0.52
      group.visible = false
      this.armR.add(group)
      this.guns.set(id, { group, muzzle, twoHand })
    }
    const redDot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 4), glowMat(0xff3b5c))
    redDot.position.set(0, -0.2, -0.1)
    add('uzi', [box(0.09, 0.4, 0.12, dark, 0, -0.2), cyl(0.022, 0.022, 0.22, mid, 0, -0.5, 0, 6), box(0.07, 0.08, 0.22, mid, 0, -0.18, 0.15), box(0.095, 0.2, 0.02, glow, 0, -0.2, -0.065)], -0.62, true)
    add('deagle', [box(0.08, 0.36, 0.14, mid, 0, -0.18), box(0.06, 0.22, 0.08, dark, 0, -0.46), box(0.08, 0.1, 0.16, dark, 0, -0.07, 0.12), box(0.085, 0.3, 0.02, glow, 0, -0.2, -0.075)], -0.58, false)
    add('ak47', [box(0.09, 0.55, 0.12, dark, 0, -0.28), cyl(0.024, 0.024, 0.34, steel, 0, -0.72, 0, 6), box(0.07, 0.24, 0.1, wood, 0, -0.34, 0.13), box(0.08, 0.22, 0.1, wood, 0, 0.02, 0.02), box(0.095, 0.3, 0.02, glow, 0, -0.3, -0.065)], -0.9, true)
    add('shotgun', [box(0.1, 0.55, 0.12, wood, 0, -0.28), cyl(0.034, 0.034, 0.5, steel, 0, -0.78, 0, 8), box(0.1, 0.18, 0.1, dark, 0, -0.52, 0.07), box(0.095, 0.24, 0.02, glow, 0, -0.3, -0.065)], -1.05, true)
    add('sniper', [box(0.08, 0.7, 0.1, dark, 0, -0.35), cyl(0.018, 0.018, 0.55, steel, 0, -0.96, 0, 6), cyl(0.045, 0.045, 0.26, mat(0x20243a), 0, -0.34, -0.1, 8), box(0.07, 0.2, 0.08, wood, 0, 0.0, 0.03), redDot], -1.28, true)
    add('magnum', [box(0.1, 0.4, 0.16, gold, 0, -0.2), box(0.07, 0.28, 0.1, steel, 0, -0.54), box(0.09, 0.1, 0.17, dark, 0, -0.06, 0.13), box(0.105, 0.3, 0.02, glow, 0, -0.22, -0.085)], -0.7, false)
  }

  selectWeapon(id: string): void {
    this.weaponId = id
    const gun = this.guns.get(id) ?? this.guns.get('uzi')!
    for (const g of this.guns.values()) g.group.visible = g === gun
    this.activeMuzzle = gun.muzzle
    gun.muzzle.add(this.flash)
  }

  /** World position of the active gun's muzzle. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true)
    return (this.activeMuzzle ?? this.root).getWorldPosition(out)
  }

  /** World positions of the two jetpack nozzles (for flame particles). */
  nozzleWorld(index: 0 | 1, out: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true)
    return out.set((index === 0 ? -1 : 1) * 0.1, 0.8, 0.3).applyMatrix4(this.model.matrixWorld)
  }

  get flameColors(): { main: string; core: string } {
    const f = optionOf('jetpack_flame', this.cosmetics.jetpack_flame)
    return { main: f.color ?? '#ff8a2a', core: f.core ?? '#fff3b0' }
  }

  showMuzzleFlash(): void {
    this.flashLeft = 0.05
    this.flash.visible = true
    this.flash.rotation.y = Math.random() * Math.PI
    this.flash.scale.set(1 + Math.random() * 0.5, 1.8 + Math.random() * 0.8, 1 + Math.random() * 0.5)
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible
  }

  setShield(on: boolean): void {
    if (this.shield) this.shield.visible = on
  }

  /** Floating name tag. Drawn to a canvas with fillText, so names are never interpreted as markup. */
  setLabel(text: string, color: string, throughWalls: boolean): void {
    if (this.label) { this.root.remove(this.label); (this.label.material as THREE.SpriteMaterial).map?.dispose(); this.label.material.dispose() }
    this.labelSpec = { text, color, through: throughWalls }
    const c = document.createElement('canvas')
    c.width = 256; c.height = 64
    const g = c.getContext('2d')!
    g.font = 'bold 30px system-ui, sans-serif'
    g.textAlign = 'center'; g.textBaseline = 'middle'
    g.lineWidth = 6; g.strokeStyle = 'rgba(8,4,24,0.9)'
    g.strokeText(text, 128, 32)
    g.fillStyle = color
    g.fillText(text, 128, 32)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: !throughWalls, depthWrite: false }))
    sprite.scale.set(1.9, 0.48, 1)
    sprite.position.y = 2.55
    sprite.renderOrder = 20
    this.label = sprite
    this.root.add(sprite)
  }

  animate(dt: number, time: number, pose: AvatarPose): void {
    if (this.flashLeft > 0) {
      this.flashLeft -= dt
      if (this.flashLeft <= 0) this.flash.visible = false
    }
    if (pose.emote && this.emoteT <= 0) this.playEmote()
    this.emoteT = Math.max(0, this.emoteT - dt)
    this.emoteBlend += ((this.emoteT > 0 ? 1 : 0) - this.emoteBlend) * Math.min(1, dt * 10)

    const moving = pose.grounded && pose.speed > 0.05
    this.phase += dt * (7 + pose.speed * 7) * (moving ? 1 : 0)
    const swing = Math.sin(this.phase) * 0.95 * pose.speed
    const bob = pose.grounded
      ? (moving ? Math.abs(Math.sin(this.phase)) * 0.06 : Math.sin(time * 2) * 0.014)
      : Math.sin(time * 3.2) * 0.035

    const hover = !pose.grounded ? 1 : 0
    this.legPose += (hover - this.legPose) * Math.min(1, dt * 10)
    const thrustTuck = pose.thrust * 0.25
    this.legL.rotation.x = swing * (1 - this.legPose) + this.legPose * (0.28 + thrustTuck)
    this.legR.rotation.x = -swing * (1 - this.legPose) + this.legPose * (-0.12 + thrustTuck * 0.4)

    if (pose.weaponId !== this.weaponId) this.selectWeapon(pose.weaponId)
    const twoHand = this.guns.get(this.weaponId)?.twoHand ?? false
    const aim = Math.PI / 2 + pose.pitch
    this.armR.rotation.x = aim
    this.armR.rotation.z = 0
    if (twoHand) {
      this.armL.rotation.x = aim - 0.1
      this.armL.rotation.z = -0.32
    } else {
      this.armL.rotation.x = moving ? -swing * 0.9 : 0.05
      this.armL.rotation.z = 0
    }

    if (this.emoteBlend > 0.02) {
      const k = this.emoteBlend
      if (this.emoteMode === 'wave') {
        this.armL.rotation.x = THREE.MathUtils.lerp(this.armL.rotation.x, Math.PI * 0.95, k)
        this.armL.rotation.z = THREE.MathUtils.lerp(this.armL.rotation.z, -0.4 + Math.sin(time * 12) * 0.35, k)
      } else if (this.emoteMode === 'salute') {
        this.armL.rotation.x = THREE.MathUtils.lerp(this.armL.rotation.x, Math.PI * 0.62, k)
        this.armL.rotation.z = THREE.MathUtils.lerp(this.armL.rotation.z, -0.95, k)
      }
    }

    const targetLean = -(pose.speed * 0.16 + pose.thrust * 0.1 * (pose.grounded ? 0 : 1))
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 8)
    this.model.rotation.x = this.lean
    this.model.position.y = bob

    for (const flame of this.flames) {
      flame.visible = pose.thrust > 0.03
      if (!flame.visible) continue
      const flicker = 0.85 + Math.random() * 0.3
      flame.scale.set(0.8 + pose.thrust * 0.5, (0.35 + pose.thrust * 1.1) * flicker, 0.8 + pose.thrust * 0.5)
      flame.position.y = 0.8 - 0.4 * flame.scale.y
    }
    if (this.shield?.visible) this.shield.scale.setScalar(1 + Math.sin(time * 8) * 0.03)
  }
}
