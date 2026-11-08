/**
 * Game-owned parameter manager used by the development-only Tweak panel. Every control here has a
 * real gameplay consumer in `player.ts`, `jetpack.ts` or `camera.ts`.
 * Apply only changes the running preview; defaults in config.ts are never mutated.
 */
import { CONFIG, DEFAULT_CONFIG } from './config'

type Mode = 'LIVE' | 'NEXT_ACTION'
type Boundary = 'jump'
type Control = { id: string; type: 'number'; category: string; label: string; description: string; unit: string;
  default: number; min: number; max: number; step: number; applyMode: Mode; integrity: 'COSMETIC' | 'GAMEPLAY' }
type Binding = { control: Control; boundary?: Boundary; read(): number; write(value: number): void }

const CATEGORY: Partial<Record<keyof typeof CONFIG, string>> = { player: 'Movement', jetpack: 'Jetpack', camera: 'Camera' }
const bindings: Binding[] = []

function number<S extends keyof typeof CONFIG>(section: S, key: keyof typeof CONFIG[S] & string,
  label: string, min: number, max: number, step: number, unit: string, boundary?: Boundary): void {
  const values = CONFIG[section] as Record<string, number>
  const defaults = DEFAULT_CONFIG[section] as Record<string, number>
  bindings.push({ control: Object.freeze({ id: `${section}.${key}`, type: 'number', category: CATEGORY[section] ?? 'Game', label,
    description: boundary === 'jump' ? 'Applies when the next jump starts.' : 'Updates this preview immediately.',
    unit, default: defaults[key], min, max, step,
    applyMode: boundary ? 'NEXT_ACTION' : 'LIVE',
    integrity: section === 'camera' ? 'COSMETIC' : 'GAMEPLAY' }), boundary,
    read: () => values[key], write: value => { values[key] = value } })
}

number('player', 'walkSpeed', 'Walking speed', 3, 12, 0.5, 'm/s')
number('player', 'sprintSpeed', 'Sprint speed', 4, 18, 0.5, 'm/s')
number('player', 'jumpSpeed', 'Jump strength', 5, 14, 0.5, 'm/s', 'jump')
number('jetpack', 'drainPerSecond', 'Fuel drain', 10, 80, 5, '/s')
number('jetpack', 'regenPerSecond', 'Fuel regeneration', 5, 60, 1, '/s')
number('jetpack', 'burstAccel', 'Burst thrust', 30, 80, 2, 'm/s²')
number('jetpack', 'sustainAccel', 'Sustained thrust', 12, 40, 1, 'm/s²')
number('jetpack', 'maxRiseSpeed', 'Maximum climb speed', 5, 18, 0.5, 'm/s')
number('camera', 'fov', 'Field of view', 50, 100, 1, '°')
number('camera', 'distance', 'Camera distance', 2.5, 9, 0.1, 'm')

const byId = new Map(bindings.map(binding => [binding.control.id, binding]))
let requested = Object.fromEntries(bindings.map(({ control }) => [control.id, control.default]))
const valid = (values: Record<string, number>) => values['player.walkSpeed'] <= values['player.sprintSpeed']

let unranked = false
const gameplayModified = () => bindings.some(binding => binding.control.integrity === 'GAMEPLAY' && binding.read() !== binding.control.default)

export const tuning = {
  get unranked(): boolean { return unranked },
  controls: Object.freeze(bindings.map(binding => binding.control)),
  read() {
    return { requested: { ...requested }, active: Object.fromEntries(bindings.map(binding => [binding.control.id, binding.read()])) }
  },
  apply(patch: unknown): void {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid patch')
    const entries = Object.entries(patch)
    if (entries.length > bindings.length) throw new Error('Invalid patch')
    for (const [id, value] of entries) {
      const control = byId.get(id)?.control
      if (!control || typeof value !== 'number' || !Number.isFinite(value) || value < control.min || value > control.max) throw new Error('Invalid value')
      const steps = (value - control.min) / control.step
      if (value !== control.default && Math.abs(steps - Math.round(steps)) > 1e-7) throw new Error('Invalid increment')
    }
    const candidate = { ...requested, ...patch } as Record<string, number>
    const nextActive = this.read().active
    for (const [id, value] of entries) if (byId.get(id)!.control.applyMode === 'LIVE') nextActive[id] = value
    if (!valid(candidate) || !valid(nextActive)) throw new Error('Walking speed must not exceed sprint speed')
    // All writes are simple assignments, synchronously committed before the next simulation step.
    requested = candidate
    for (const [id, value] of entries) {
      const binding = byId.get(id)!
      if (binding.control.applyMode === 'LIVE') binding.write(value)
    }
    unranked ||= gameplayModified()
  },
  activate(boundary: Boundary | 'run'): void {
    for (const binding of bindings) if (binding.boundary === boundary) binding.write(requested[binding.control.id])
    // Reset only at a new run; resetting values mid-run cannot restore eligibility.
    unranked = boundary === 'run' ? gameplayModified() : unranked || gameplayModified()
  },
}
