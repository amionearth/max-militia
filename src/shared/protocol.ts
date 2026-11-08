/**
 * Wire protocol shared by the browser and the Node server. JSON text frames. Every client message
 * is validated by `parseClientMessage` before the server acts on it: the server never trusts a
 * client for positions, damage or pickups, only for input intent.
 */
import { sanitizeCosmetics, sanitizeName, type Cosmetics } from './cosmetics'
import { sanitizeFrame, type InputFrame } from './playerSim'
import type { Snapshot } from './match'
import matchData from '../data/match.json'

export const PROTOCOL_VERSION = 2
export const ROOM_CODE_LENGTH = 5
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O/1/I/L

export type RoomSettings = { killLimit: number; timeLimitMinutes: number }
export type RosterEntry = { id: string; name: string; cosmetics: Cosmetics; team: number; connected: boolean; host: boolean }
export type ResultRow = { id: string; name: string; team: number; kills: number; deaths: number }

export type ClientMessage =
  | { t: 'create'; name: string; cosmetics: Cosmetics }
  | { t: 'join'; code: string; name: string; cosmetics: Cosmetics }
  | { t: 'resume'; code: string; token: string }
  | { t: 'cosmetics'; cosmetics: Cosmetics }
  | { t: 'settings'; settings: RoomSettings }
  | { t: 'start' }
  | { t: 'input'; frames: InputFrame[] }
  | { t: 'ping'; c: number }
  | { t: 'leave' }

export type ErrorCode =
  | 'bad_message' | 'bad_name' | 'no_room' | 'room_full' | 'not_host' | 'bad_state' | 'rate_limited'
  | 'server_busy' | 'version' | 'bad_token' | 'origin'

export type ServerMessage =
  | { t: 'hello'; v: number; maxPlayers: number }
  | { t: 'welcome'; id: string; code: string; token: string }
  | { t: 'lobby'; code: string; state: 'lobby' | 'match' | 'results'; hostId: string; roster: RosterEntry[]; settings: RoomSettings; max: number }
  | { t: 'snap'; s: Snapshot }
  | { t: 'results'; scores: number[]; winner: number; rows: ResultRow[] }
  | { t: 'pong'; c: number; s: number }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'left'; reason: string }

export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const code = raw.trim().toUpperCase()
  if (code.length !== ROOM_CODE_LENGTH) return null
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null
  return code
}

export function sanitizeSettings(raw: unknown): RoomSettings | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const [kMin, kMax] = matchData.limits.killLimit
  const [tMin, tMax] = matchData.limits.timeLimitMinutes
  const k = Math.round(Number(r.killLimit))
  const t = Math.round(Number(r.timeLimitMinutes))
  if (!Number.isFinite(k) || !Number.isFinite(t)) return null
  return { killLimit: Math.min(kMax, Math.max(kMin, k)), timeLimitMinutes: Math.min(tMax, Math.max(tMin, t)) }
}

export const DEFAULT_SETTINGS: RoomSettings = { killLimit: matchData.defaults.killLimit, timeLimitMinutes: matchData.defaults.timeLimitMinutes }

/** Parse and validate one raw client text frame. Returns a message or an error string. */
export function parseClientMessage(raw: string): { ok: true; msg: ClientMessage } | { ok: false; code: ErrorCode; message: string } {
  const bad = (code: ErrorCode, message: string) => ({ ok: false as const, code, message })
  let data: unknown
  try { data = JSON.parse(raw) } catch { return bad('bad_message', 'Invalid JSON') }
  if (!data || typeof data !== 'object') return bad('bad_message', 'Invalid message')
  const m = data as Record<string, unknown>
  switch (m.t) {
    case 'create': {
      const name = sanitizeName(m.name)
      if (!name) return bad('bad_name', 'Pick a name with 2-16 letters or digits')
      return { ok: true, msg: { t: 'create', name, cosmetics: sanitizeCosmetics(m.cosmetics) } }
    }
    case 'join': {
      const name = sanitizeName(m.name)
      const code = normalizeRoomCode(m.code)
      if (!name) return bad('bad_name', 'Pick a name with 2-16 letters or digits')
      if (!code) return bad('no_room', 'That room code is not valid')
      return { ok: true, msg: { t: 'join', code, name, cosmetics: sanitizeCosmetics(m.cosmetics) } }
    }
    case 'resume': {
      const code = normalizeRoomCode(m.code)
      if (!code || typeof m.token !== 'string' || !/^[a-f0-9]{32}$/.test(m.token)) return bad('bad_token', 'Cannot resume')
      return { ok: true, msg: { t: 'resume', code, token: m.token } }
    }
    case 'cosmetics': return { ok: true, msg: { t: 'cosmetics', cosmetics: sanitizeCosmetics(m.cosmetics) } }
    case 'settings': {
      const settings = sanitizeSettings(m.settings)
      return settings ? { ok: true, msg: { t: 'settings', settings } } : bad('bad_message', 'Invalid settings')
    }
    case 'start': return { ok: true, msg: { t: 'start' } }
    case 'leave': return { ok: true, msg: { t: 'leave' } }
    case 'ping': return typeof m.c === 'number' && Number.isFinite(m.c) ? { ok: true, msg: { t: 'ping', c: m.c } } : bad('bad_message', 'Invalid ping')
    case 'input': {
      if (!Array.isArray(m.frames) || m.frames.length === 0 || m.frames.length > 10) return bad('bad_message', 'Invalid input batch')
      const frames: InputFrame[] = []
      for (const f of m.frames) {
        const frame = sanitizeFrame(f)
        if (frame) frames.push(frame)
      }
      return frames.length ? { ok: true, msg: { t: 'input', frames } } : bad('bad_message', 'No valid frames')
    }
    default: return bad('bad_message', 'Unknown message type')
  }
}
