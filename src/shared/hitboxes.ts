/**
 * Aim ray and character hit boxes shared by the client (tracers, prediction) and the server
 * (authoritative hit detection). Plain numbers only, no Three.js.
 */
import { rayBox, type Box } from './collision'
import { CONFIG } from './config'

export type Ray = { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }
export type CharacterHit = { t: number; head: boolean }

/**
 * The bullet ray starts level with the player's head, offset to the shoulder the camera sits on,
 * and travels along the camera forward vector, so it passes through the centred crosshair.
 */
export function aimRay(x: number, y: number, z: number, yaw: number, pitch: number): Ray {
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const fx = -Math.sin(yaw) * cp
  const fy = sp
  const fz = -Math.cos(yaw) * cp
  const rx = Math.cos(yaw)
  const rz = -Math.sin(yaw)
  const cam = CONFIG.camera
  return {
    ox: x + rx * cam.shoulder - fx * 0.2 * sp,
    oy: y + cam.height + 0.2 - fy * 0.2 * sp,
    oz: z + rz * cam.shoulder - fz * 0.2 * sp,
    dx: fx, dy: fy, dz: fz,
  }
}

/** Random direction inside a cone (half-angle in degrees) around the ray direction. */
export function spreadDirection(ray: Ray, coneDegrees: number, r1: number, r2: number): [number, number, number] {
  const cone = (coneDegrees * Math.PI) / 180
  if (cone <= 0) return [ray.dx, ray.dy, ray.dz]
  // u: horizontal axis perpendicular to forward, v = forward x u.
  let ux = ray.dz
  let uz = -ray.dx
  const ul = Math.hypot(ux, uz) || 1
  ux /= ul
  uz /= ul
  const vx = ray.dy * uz
  const vy = ray.dz * ux - ray.dx * uz
  const vz = -ray.dy * ux
  const a = Math.tan(cone) * Math.sqrt(r1)
  const phi = r2 * Math.PI * 2
  const ca = a * Math.cos(phi)
  const sa = a * Math.sin(phi)
  let dx = ray.dx + ux * ca + vx * sa
  let dy = ray.dy + vy * sa
  let dz = ray.dz + uz * ca + vz * sa
  const l = Math.hypot(dx, dy, dz) || 1
  dx /= l; dy /= l; dz /= l
  return [dx, dy, dz]
}

const BODY_HALF = 0.4
const HEAD_HALF = 0.23

/** The two boxes (body, head) of a character standing at feet position (x,y,z). */
export function characterBoxes(x: number, y: number, z: number, grow = 0): { body: Box; head: Box } {
  return {
    body: { id: 'body', minX: x - BODY_HALF - grow, maxX: x + BODY_HALF + grow, minY: y + 0.1, maxY: y + 1.55, minZ: z - BODY_HALF - grow, maxZ: z + BODY_HALF + grow },
    head: { id: 'head', minX: x - HEAD_HALF - grow, maxX: x + HEAD_HALF + grow, minY: y + 1.5, maxY: y + 1.96, minZ: z - HEAD_HALF - grow, maxZ: z + HEAD_HALF + grow },
  }
}

export function rayCharacter(x: number, y: number, z: number, ray: { ox: number; oy: number; oz: number }, dx: number, dy: number, dz: number, maxT: number): CharacterHit | null {
  const { body, head } = characterBoxes(x, y, z, 0.04)
  const h = rayBox(ray.ox, ray.oy, ray.oz, dx, dy, dz, head, maxT)
  const b = rayBox(ray.ox, ray.oy, ray.oz, dx, dy, dz, body, maxT)
  if (h && (!b || h.t <= b.t)) return { t: h.t, head: true }
  if (b) return { t: b.t, head: false }
  return null
}

/** A point roughly at the character's torso, used for blast/gas/proximity distance checks. */
export function torsoPoint(x: number, y: number, z: number): [number, number, number] {
  return [x, y + 1.0, z]
}
