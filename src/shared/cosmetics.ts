/**
 * Cosmetic selection and display-name validation. Shared by the browser UI and the server so both
 * accept exactly the same IDs. Cosmetics are visual only: nothing here touches stats or hitboxes.
 */
import data from '../data/avatar_slots.json'

export type CosmeticSlot = 'skin' | 'head' | 'face' | 'torso' | 'legs' | 'boots' | 'jetpack_flame' | 'emote'
export type Cosmetics = Record<CosmeticSlot, string>
export type CosmeticOption = { id: string; label: string; color?: string; core?: string }

export const SLOT_ORDER = data.slotOrder as CosmeticSlot[]
export const SLOT_LABELS = Object.fromEntries(SLOT_ORDER.map(s => [s, (data.slots as Record<string, { label: string }>)[s].label])) as Record<CosmeticSlot, string>
export const SLOT_OPTIONS = Object.fromEntries(
  SLOT_ORDER.map(s => [s, (data.slots as Record<string, { options: CosmeticOption[] }>)[s].options]),
) as Record<CosmeticSlot, CosmeticOption[]>
export const DEFAULT_COSMETICS: Cosmetics = { ...(data.defaults as Cosmetics) }

export function optionOf(slot: CosmeticSlot, id: string): CosmeticOption {
  return SLOT_OPTIONS[slot].find(o => o.id === id) ?? SLOT_OPTIONS[slot][0]
}

/** Accepts anything (e.g. parsed localStorage / network JSON) and returns a complete, valid selection. */
export function sanitizeCosmetics(raw: unknown): Cosmetics {
  const out = { ...DEFAULT_COSMETICS }
  if (!raw || typeof raw !== 'object') return out
  for (const slot of SLOT_ORDER) {
    const value = (raw as Record<string, unknown>)[slot]
    if (typeof value === 'string' && SLOT_OPTIONS[slot].some(o => o.id === value)) out[slot] = value
  }
  return out
}

export function randomCosmetics(rand: () => number = Math.random): Cosmetics {
  const out = { ...DEFAULT_COSMETICS }
  for (const slot of SLOT_ORDER) {
    const options = SLOT_OPTIONS[slot]
    out[slot] = options[Math.floor(rand() * options.length) % options.length].id
  }
  return out
}

export const NAME_MIN = 2
export const NAME_MAX = 16

/**
 * Normalises a display name: strips control/format characters, collapses whitespace and trims.
 * Returns null when the result is empty or too short/long. This is a label, not an identity.
 */
export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu, '')
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const length = Array.from(cleaned).length
  if (length < NAME_MIN || length > NAME_MAX) return null
  return cleaned
}

/** Same as sanitizeName, but truncates over-long input first (used for live typing in the UI). */
export function clampName(raw: string): string {
  return Array.from(raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu, '')).slice(0, NAME_MAX).join('')
}
