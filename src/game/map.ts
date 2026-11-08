/**
 * Builds the SKYSPIRE arena from the shared arena data: the same solids feed the collision world
 * and the neon low-poly meshes. Sky, floating debris, rings, beacon and the glowing void are all
 * generated from primitives and canvas textures; no external art.
 */
import * as THREE from 'three'
import { ARENA, buildWorld, type Bounds } from '../shared/arenaData'
import type { CollisionWorld } from '../shared/collision'

export class Arena {
  readonly scene = new THREE.Scene()
  readonly world: CollisionWorld = buildWorld()
  readonly bounds: Bounds = ARENA.bounds
  readonly sun: THREE.DirectionalLight
  readonly name = ARENA.name
  private readonly rings: { mesh: THREE.Mesh; speed: number }[] = []
  private readonly debris: THREE.InstancedMesh
  private readonly debrisData: { x: number; y: number; z: number; s: number; rx: number; ry: number; spin: number; bob: number }[] = []
  private beacon: THREE.Mesh | null = null
  private voidPlane: THREE.Mesh

  constructor(shadowMapSize: number) {
    this.scene.background = new THREE.Color(0x0a0618)
    this.scene.fog = new THREE.Fog(0x1a0b36, 80, 300)
    this.buildSky()
    this.buildSolids()
    this.voidPlane = this.buildVoid()
    this.buildDecor()
    this.debris = this.buildDebris()
    this.updateDebris(0)

    this.scene.add(new THREE.HemisphereLight(0x9aa6ff, 0x4a1f6a, 2.4))
    this.sun = new THREE.DirectionalLight(0xc9d2ff, 1.4)
    this.sun.position.set(26, 60, 30)
    this.sun.target.position.set(0, 10, 0)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize)
    const cam = this.sun.shadow.camera
    const s = ARENA.shadow
    cam.left = -s.halfWidth; cam.right = s.halfWidth; cam.top = s.halfHeight; cam.bottom = -s.halfHeight; cam.near = 5; cam.far = s.far
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.04
    this.scene.add(this.sun, this.sun.target)
  }

  private color(key: string): string {
    return ARENA.colors[key] ?? '#ffffff'
  }

  private buildSolids(): void {
    const grid = gridTexture('#27305e', '#5f78e6')
    const rockGrid = gridTexture('#2a1d45', '#7a58e0')
    const crate = crateTexture()
    const std = (map: THREE.Texture, color: number, rough = 0.7, metal = 0.2) =>
      new THREE.MeshStandardMaterial({ map, color, roughness: rough, metalness: metal })
    const mats: Record<string, THREE.MeshStandardMaterial> = {
      ground: std(grid, 0xffffff, 0.85, 0.1),
      islet: std(rockGrid, 0xd8ccff),
      rock: std(rockGrid, 0xb9a8f0, 0.9, 0.1),
      tower: std(grid, 0xb8c0e6, 0.7, 0.25),
      deck: std(grid, 0xd0d8ff, 0.65),
      bridge: std(grid, 0xd0e8ff, 0.6, 0.25),
      wall: std(grid, 0xa9b2e0, 0.75, 0.2),
      crate: std(crate, 0xffffff, 0.75, 0.1),
    }
    const edgeMats = new Map<string, THREE.LineBasicMaterial>()
    const edgeMat = (key: string) => {
      let m = edgeMats.get(key)
      if (!m) { m = new THREE.LineBasicMaterial({ color: this.color(key) }); edgeMats.set(key, m) }
      return m
    }
    for (const s of ARENA.solids) {
      const [w, h, d] = s.size
      const geo = new THREE.BoxGeometry(w, h, d)
      if (s.kind !== 'crate') scaleUVs(geo, w, h, d, 4)
      const mesh = new THREE.Mesh(geo, mats[s.kind] ?? mats.ground)
      mesh.position.set(s.pos[0], s.pos[1], s.pos[2])
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat(s.edge)))
      // Islets and rocks get a tapered underside so they read as floating chunks of stone.
      if (s.kind === 'islet' || s.kind === 'rock') {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(Math.min(w, d) * 0.5, Math.max(1.6, h * 2.2), 6), mats.rock)
        cone.rotation.x = Math.PI
        cone.position.y = -h / 2 - Math.max(1.6, h * 2.2) / 2 + 0.02
        cone.castShadow = true
        mesh.add(cone)
      }
      this.scene.add(mesh)
    }
  }

  private buildVoid(): THREE.Mesh {
    const tex = gridTexture('#1a0508', '#ff2a3d')
    tex.repeat.set(14, 7)
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA.bounds.x * 2 + 40, ARENA.bounds.z * 2 + 30),
      new THREE.MeshBasicMaterial({ map: tex, color: 0xff5566, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    plane.rotation.x = -Math.PI / 2
    plane.position.set(0, ARENA.bounds.killY + 1.5, 0)
    this.scene.add(plane)
    return plane
  }

  private buildDecor(): void {
    const decor = ARENA.decor
    for (const r of decor.rings) {
      const mesh = new THREE.Mesh(
        new THREE.TorusGeometry(r.r, 0.09, 6, 48),
        new THREE.MeshBasicMaterial({ color: this.color(r.color) }),
      )
      mesh.rotation.x = Math.PI / 2
      mesh.position.set(0, r.y, 0)
      this.scene.add(mesh)
      this.rings.push({ mesh, speed: r.speed })
    }
    const b = decor.beacon
    this.beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.5, b.height, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: this.color(b.color), transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    )
    this.beacon.position.set(b.pos[0], b.pos[1] + b.height / 2, b.pos[2])
    this.scene.add(this.beacon)
    for (const ban of decor.banners) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(ban.size[0], ban.size[1], ban.size[2]),
        new THREE.MeshBasicMaterial({ color: this.color(ban.color), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
      )
      m.position.set(ban.pos[0], ban.pos[1], ban.pos[2])
      this.scene.add(m)
    }
  }

  private buildDebris(): THREE.InstancedMesh {
    const d = ARENA.decor.debris
    const mesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: 0x6a58b8, roughness: 0.9, flatShading: true, emissive: 0x1a0f3a }),
      d.count,
    )
    // Seeded so every client sees the same sky.
    let seed = 1234
    const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
    for (let i = 0; i < d.count; i++) {
      const a = rand() * Math.PI * 2
      const r = d.minR + rand() * (d.maxR - d.minR)
      this.debrisData.push({
        x: Math.cos(a) * r, z: Math.sin(a) * r, y: d.minY + rand() * (d.maxY - d.minY),
        s: 0.8 + rand() * 3.4, rx: rand() * 6, ry: rand() * 6, spin: (rand() - 0.5) * 0.4, bob: rand() * 6,
      })
    }
    this.scene.add(mesh)
    return mesh
  }

  private readonly tmpM = new THREE.Matrix4()
  private readonly tmpQ = new THREE.Quaternion()
  private readonly tmpE = new THREE.Euler()
  private updateDebris(t: number): void {
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()
    this.debrisData.forEach((d, i) => {
      this.tmpE.set(d.rx + t * d.spin, d.ry + t * d.spin * 0.7, 0)
      this.tmpQ.setFromEuler(this.tmpE)
      p.set(d.x, d.y + Math.sin(t * 0.3 + d.bob) * 0.8, d.z)
      s.set(d.s, d.s * 0.7, d.s)
      this.tmpM.compose(p, this.tmpQ, s)
      this.debris.setMatrixAt(i, this.tmpM)
    })
    this.debris.instanceMatrix.needsUpdate = true
  }

  /** Animate decor (rings, beacon, debris, void shimmer). */
  update(time: number): void {
    for (const r of this.rings) r.mesh.rotation.z = time * r.speed
    if (this.beacon) (this.beacon.material as THREE.MeshBasicMaterial).opacity = 0.35 + Math.sin(time * 2) * 0.1
    this.updateDebris(time)
    ;(this.voidPlane.material as THREE.MeshBasicMaterial).opacity = 0.7 + Math.sin(time * 1.5) * 0.1
  }

  private buildSky(): void {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(520, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `varying vec3 vP;
          void main(){
            float h = vP.y;
            vec3 top = vec3(0.012, 0.016, 0.06);
            vec3 mid = vec3(0.10, 0.035, 0.24);
            vec3 hor = vec3(0.70, 0.08, 0.42);
            vec3 c = mix(hor, mid, smoothstep(0.0, 0.3, h));
            c = mix(c, top, smoothstep(0.18, 0.85, h));
            if (h < 0.0) c = mix(hor * 0.7, vec3(0.04, 0.01, 0.1), smoothstep(0.0, -0.5, h));
            vec3 moonDir = normalize(vec3(-0.4, 0.34, -0.85));
            float d = dot(vP, moonDir);
            c += vec3(0.85, 0.65, 1.0) * smoothstep(0.991, 0.9945, d) * 0.95;
            c += vec3(0.55, 0.3, 0.95) * pow(max(d, 0.0), 40.0) * 0.32;
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    )
    this.scene.add(sky)
    const count = 460
    const pos = new Float32Array(count * 3)
    let seed = 99
    const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
    for (let i = 0; i < count; i++) {
      const theta = rand() * Math.PI * 2
      const y = -0.25 + rand() * 1.2
      const yy = Math.min(0.98, y)
      const r = Math.sqrt(1 - yy * yy)
      pos.set([Math.cos(theta) * r * 500, yy * 500, Math.sin(theta) * r * 500], i * 3)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xcfd6ff, size: 1.6, sizeAttenuation: false, fog: false, depthWrite: false })))
  }
}

/** Scales a box's UVs so textures keep a constant world-space size (`tile` metres per repeat). */
function scaleUVs(geo: THREE.BoxGeometry, w: number, h: number, d: number, tile: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]
  for (let face = 0; face < 6; face++) {
    for (let v = 0; v < 4; v++) {
      const i = face * 4 + v
      uv.setXY(i, (uv.getX(i) * dims[face][0]) / tile, (uv.getY(i) * dims[face][1]) / tile)
    }
  }
  uv.needsUpdate = true
}

export function gridTexture(bg: string, line: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = bg
  g.fillRect(0, 0, 128, 128)
  g.strokeStyle = line
  g.lineWidth = 3
  g.strokeRect(1.5, 1.5, 125, 125)
  g.globalAlpha = 0.35
  g.lineWidth = 1
  for (const p of [32, 64, 96]) {
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 128); g.moveTo(0, p); g.lineTo(128, p); g.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function crateTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#6a4318'
  g.fillRect(0, 0, 128, 128)
  g.strokeStyle = '#ffb020'
  g.lineWidth = 8
  g.strokeRect(4, 4, 120, 120)
  g.lineWidth = 5
  g.beginPath(); g.moveTo(10, 10); g.lineTo(118, 118); g.moveTo(118, 10); g.lineTo(10, 118); g.stroke()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
