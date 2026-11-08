/**
 * Minimal AABB collision world (no Three.js dependency, so it is unit tested in Node).
 * - `moveBody` slides a box-shaped body against solid boxes, one axis at a time.
 * - `raycast` finds the nearest box along a ray (used for bullets, aiming and camera collision).
 * Body position is the bottom centre of the body box.
 */
export type Box = { id: string; minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
export type Body = { x: number; y: number; z: number; vx: number; vy: number; vz: number }
export type MoveResult = { grounded: boolean; hitCeiling: boolean; hitWall: boolean; impact: number }
export type RayHit = { t: number; nx: number; ny: number; nz: number; box?: Box }

const EPS = 1e-4

export function boxFromCenter(id: string, pos: readonly number[], size: readonly number[]): Box {
  const [cx, cy, cz] = pos
  const [w, h, d] = size
  return { id, minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2, minZ: cz - d / 2, maxZ: cz + d / 2 }
}

/** Slab-method ray/box test. Returns null for a miss or a hit beyond `maxT`. */
export function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: Box, maxT: number): RayHit | null {
  let tMin = 0
  let tMax = maxT
  let nx = 0
  let ny = 0
  let nz = 0
  const axes: [number, number, number, number, 0 | 1 | 2][] = [
    [ox, dx, b.minX, b.maxX, 0], [oy, dy, b.minY, b.maxY, 1], [oz, dz, b.minZ, b.maxZ, 2],
  ]
  for (const [o, d, lo, hi, axis] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null
      continue
    }
    let t1 = (lo - o) / d
    let t2 = (hi - o) / d
    let sign = -1
    if (t1 > t2) { [t1, t2] = [t2, t1]; sign = 1 }
    if (t1 > tMin) {
      tMin = t1
      nx = axis === 0 ? sign : 0
      ny = axis === 1 ? sign : 0
      nz = axis === 2 ? sign : 0
    }
    tMax = Math.min(tMax, t2)
    if (tMin > tMax) return null
  }
  if (tMin > maxT) return null
  return { t: tMin, nx, ny, nz, box: b }
}

export class CollisionWorld {
  constructor(readonly boxes: Box[]) {}

  private overlaps(x: number, y: number, z: number, hx: number, height: number, b: Box): boolean {
    return x + hx > b.minX && x - hx < b.maxX && y + height > b.minY && y < b.maxY && z + hx > b.minZ && z - hx < b.maxZ
  }

  /** Whether a body box at this position intersects any solid. */
  isBlocked(x: number, y: number, z: number, halfWidth: number, height: number): boolean {
    return this.boxes.some(b => this.overlaps(x, y, z, halfWidth, height, b))
  }

  moveBody(body: Body, halfWidth: number, height: number, dt: number): MoveResult {
    const result: MoveResult = { grounded: false, hitCeiling: false, hitWall: false, impact: 0 }
    const hx = halfWidth

    body.x += body.vx * dt
    for (const b of this.boxes) {
      if (!this.overlaps(body.x, body.y, body.z, hx, height, b)) continue
      body.x = body.vx > 0 ? b.minX - hx - EPS : b.maxX + hx + EPS
      body.vx = 0
      result.hitWall = true
    }
    body.z += body.vz * dt
    for (const b of this.boxes) {
      if (!this.overlaps(body.x, body.y, body.z, hx, height, b)) continue
      body.z = body.vz > 0 ? b.minZ - hx - EPS : b.maxZ + hx + EPS
      body.vz = 0
      result.hitWall = true
    }
    body.y += body.vy * dt
    for (const b of this.boxes) {
      if (!this.overlaps(body.x, body.y, body.z, hx, height, b)) continue
      if (body.vy <= 0) {
        body.y = b.maxY
        result.grounded = true
        result.impact = Math.max(result.impact, -body.vy)
      } else {
        body.y = b.minY - height - EPS
        result.hitCeiling = true
      }
      body.vy = 0
    }
    // Standing exactly on a surface produces no overlap, so probe just below the feet.
    if (!result.grounded && body.vy <= 0 && this.isBlocked(body.x, body.y - 0.03, body.z, hx - 0.01, height)) result.grounded = true
    return result
  }

  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): RayHit | null {
    let best: RayHit | null = null
    for (const b of this.boxes) {
      const hit = rayBox(ox, oy, oz, dx, dy, dz, b, best ? best.t : maxT)
      if (hit && (!best || hit.t < best.t)) best = hit
    }
    return best
  }
}
