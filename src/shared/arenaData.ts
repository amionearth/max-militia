/**
 * Arena data access shared by the renderer, the simulation and the server. The JSON file is the
 * single source of truth: the same solids feed both the collision world and the rendered meshes.
 */
import arena from '../data/arena.json'
import { boxFromCenter, CollisionWorld } from './collision'

export type SolidSpec = { id: string; kind: string; pos: number[]; size: number[]; edge: string }
export type SpawnSpec = { id: string; team: number; x: number; y: number; z: number; yaw: number }
export type PickupSpot = { id: string; x: number; y: number; z: number; tier: 'low' | 'mid' | 'high' }
export type DummySpec = { id: string; x: number; y: number; z: number; yaw: number; hp: number; respawn: number }
export type Bounds = { x: number; z: number; ceiling: number; killY: number }

export const ARENA = {
  id: arena.id,
  name: arena.name,
  tagline: arena.tagline,
  bounds: { x: arena.bounds.x, z: arena.bounds.z, ceiling: arena.bounds.ceiling, killY: arena.killY } as Bounds,
  colors: arena.colors as Record<string, string>,
  solids: arena.solids as SolidSpec[],
  spawns: arena.spawns.map(s => ({ id: s.id, team: s.team, x: s.pos[0], y: s.pos[1], z: s.pos[2], yaw: s.yaw })) as SpawnSpec[],
  pickups: arena.pickups.map(p => ({ id: p.id, x: p.pos[0], y: p.pos[1], z: p.pos[2], tier: p.tier })) as PickupSpot[],
  dummies: arena.dummies.map(d => ({ id: d.id, x: d.pos[0], y: d.pos[1], z: d.pos[2], yaw: d.yaw, hp: d.hp, respawn: d.respawn })) as DummySpec[],
  decor: arena.decor,
  camera: arena.camera,
  shadow: arena.shadow,
}

export function buildWorld(): CollisionWorld {
  return new CollisionWorld(ARENA.solids.map(s => boxFromCenter(s.id, s.pos, s.size)))
}
