/**
 * Unified input: keyboard + mouse (pointer lock) and an optional gamepad feed one action state.
 * Gameplay reads `move`, `look` and `held()/consume()`; it never checks raw keys.
 */
export type Action =
  | 'jump' | 'sprint' | 'fire' | 'reload' | 'slot1' | 'slot2' | 'swap' | 'pause'
  | 'throw' | 'gren1' | 'gren2' | 'gren3' | 'gcycle' | 'emote' | 'scoreboard'
export type InputMethod = 'keyboard' | 'gamepad'

const KEY_BINDINGS: Record<Action, string[]> = {
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  fire: [],
  reload: ['KeyR'],
  slot1: ['Digit1', 'Numpad1'],
  slot2: ['Digit2', 'Numpad2'],
  swap: [],
  pause: ['KeyP', 'Escape'],
  throw: ['KeyG'],
  gren1: ['Digit3', 'Numpad3'],
  gren2: ['Digit4', 'Numpad4'],
  gren3: ['Digit5', 'Numpad5'],
  gcycle: ['KeyQ'],
  emote: ['KeyV'],
  scoreboard: ['Tab'],
}
const MOVE_KEYS = { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'] }
// Standard gamepad mapping: A=0, B=1, X=2, Y=3, LB=4, RB=5, RT=7, Start=9, L3=10.
const PAD_BINDINGS: Record<Action, number[]> = {
  jump: [0], sprint: [4, 10], fire: [7, 5], reload: [2], slot1: [], slot2: [], swap: [3], pause: [9],
  throw: [6], gren1: [], gren2: [], gren3: [], gcycle: [1], emote: [13], scoreboard: [8],
}

export class Input {
  /** Movement intent in [-1, 1]: x = strafe right, y = forward. */
  readonly move = { x: 0, y: 0 }
  /** Look delta accumulated since the last `takeLook()` (pre-sensitivity). */
  readonly look = { x: 0, y: 0 }
  method: InputMethod = 'keyboard'
  sensitivity = 1
  invertY = false

  private keys = new Set<string>()
  private held_ = new Set<Action>()
  private pressed_ = new Set<Action>()
  private mouseDown = false
  private padPrev: boolean[] = []
  private listeners: Array<() => void> = []

  constructor(private readonly canvas: HTMLCanvasElement) {
    const on = <K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts)
      this.listeners.push(() => target.removeEventListener(type, fn as EventListener, opts))
    }
    on(window, 'keydown', e => {
      if (e.repeat) return
      this.keys.add(e.code)
      this.method = 'keyboard'
      for (const [action, codes] of Object.entries(KEY_BINDINGS) as [Action, string[]][]) {
        if (codes.includes(e.code)) this.pressed_.add(action)
      }
      if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') {
        if (!(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) e.preventDefault()
      }
    })
    on(window, 'keyup', e => { this.keys.delete(e.code); if (e.code === 'Tab') e.preventDefault() })
    on(window, 'blur', () => { this.keys.clear(); this.mouseDown = false })
    on(window, 'mousedown', e => {
      if (document.pointerLockElement === canvas && e.button === 0) {
        this.mouseDown = true
        this.pressed_.add('fire')
      }
      if (document.pointerLockElement === canvas && e.button === 2) this.pressed_.add('throw')
    })
    on(window, 'mouseup', e => { if (e.button === 0) this.mouseDown = false })
    on(window, 'mousemove', e => {
      if (document.pointerLockElement !== canvas) return
      this.look.x += e.movementX * 0.0022
      this.look.y += e.movementY * 0.0022
    })
    on(window, 'wheel', e => {
      if (document.pointerLockElement === canvas && Math.abs(e.deltaY) > 0) this.pressed_.add('swap')
    }, { passive: true })
    on(window, 'contextmenu', e => { if (document.pointerLockElement === canvas) e.preventDefault() })
  }

  lockPointer(): void {
    if (document.pointerLockElement !== this.canvas) this.canvas.requestPointerLock?.()?.catch?.(() => undefined)
  }

  unlockPointer(): void {
    if (document.pointerLockElement) document.exitPointerLock()
    this.mouseDown = false
  }

  /** Sample once per rendered frame. */
  update(frameSeconds = 1 / 60): void {
    const k = (codes: string[]) => codes.some(code => this.keys.has(code))
    let x = (k(MOVE_KEYS.right) ? 1 : 0) - (k(MOVE_KEYS.left) ? 1 : 0)
    let y = (k(MOVE_KEYS.up) ? 1 : 0) - (k(MOVE_KEYS.down) ? 1 : 0)
    this.held_.clear()
    for (const [action, codes] of Object.entries(KEY_BINDINGS) as [Action, string[]][]) {
      if (k(codes)) this.held_.add(action)
    }
    if (this.mouseDown && document.pointerLockElement === this.canvas) this.held_.add('fire')
    const pad = navigator.getGamepads?.().find(p => p && p.connected)
    if (pad) {
      const dead = (v: number) => (Math.abs(v) < 0.18 ? 0 : v)
      const lx = dead(pad.axes[0] ?? 0)
      const ly = dead(pad.axes[1] ?? 0)
      const rx = dead(pad.axes[2] ?? 0)
      const ry = dead(pad.axes[3] ?? 0)
      if (lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0 || pad.buttons.some(b => b.pressed)) this.method = 'gamepad'
      if (lx !== 0 || ly !== 0) { x = lx; y = -ly }
      this.look.x += rx * 2.7 * frameSeconds
      this.look.y += ry * 2.7 * frameSeconds
      for (const [action, buttons] of Object.entries(PAD_BINDINGS) as [Action, number[]][]) {
        if (buttons.some(i => pad.buttons[i]?.pressed)) this.held_.add(action)
        if (buttons.some(i => pad.buttons[i]?.pressed && !this.padPrev[i])) this.pressed_.add(action)
      }
      this.padPrev = pad.buttons.map(b => b.pressed)
    } else this.padPrev = []
    const len = Math.hypot(x, y)
    this.move.x = len > 1 ? x / len : x
    this.move.y = len > 1 ? y / len : y
  }

  held(action: Action): boolean {
    return this.held_.has(action)
  }

  /** Read and clear a press, so several fixed steps in one frame trigger it exactly once. */
  consume(action: Action): boolean {
    return this.pressed_.delete(action)
  }

  /** Consume the look delta with sensitivity/invert applied. */
  takeLook(): { x: number; y: number } {
    const out = { x: this.look.x * this.sensitivity, y: this.look.y * this.sensitivity * (this.invertY ? -1 : 1) }
    this.look.x = 0
    this.look.y = 0
    return out
  }

  /** Drop stale presses and look movement (menus, resume, respawn). */
  flush(): void {
    this.pressed_.clear()
    this.look.x = 0
    this.look.y = 0
  }

  dispose(): void {
    for (const off of this.listeners) off()
    this.listeners = []
  }
}

