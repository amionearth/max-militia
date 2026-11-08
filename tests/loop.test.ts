import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Input } from '../src/engine/input'
import { GameLoop } from '../src/engine/loop'

let frames: Map<number, FrameRequestCallback>
let time: number
let nextId: number
function frame(seconds = 1 / 60) {
  time += seconds * 1000
  const [id, callback] = [...frames][0]!
  frames.delete(id)
  callback(time)
}
beforeEach(() => {
  frames = new Map(); time = 0; nextId = 0
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback); return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('GameLoop scheduling', () => {
  for (const phase of ['beforeFrame', 'step', 'render'] as const) {
    it(`continues after one ${phase} exception without swallowing the error or accumulating failed time`, () => {
      const error = new Error('frame failure')
      const beforeFrame = vi.fn(); const step = vi.fn(); const render = vi.fn()
      const callbacks = { beforeFrame, step, render }
      const loop = new GameLoop(callbacks)
      callbacks[phase].mockImplementationOnce(() => { throw error })
      loop.start()
      expect(() => frame(0.25)).toThrow(error)
      expect(frames.size).toBe(1)
      step.mockClear(); render.mockClear()
      frame(0.02)
      expect(step).toHaveBeenCalledTimes(1)
      expect(render).toHaveBeenCalledTimes(1)
      expect(frames.size).toBe(1)
      loop.stop()
      expect(frames.size).toBe(0)
    })
  }
  it('keeps repeated failures bounded and start idempotent', () => {
    const step = vi.fn((): void => { throw new Error('broken step') })
    const loop = new GameLoop({ step, render: vi.fn() })
    loop.start()
    for (let i = 0; i < 3; i++) {
      expect(() => frame(0.25)).toThrow('broken step')
      loop.start()
      expect(frames.size).toBe(1)
    }
    step.mockImplementation(() => {})
    step.mockClear()
    frame(0.02)
    expect(step).toHaveBeenCalledTimes(1)
  })
  it('honors stop inside render and can restart after a failure', () => {
    const render = vi.fn((): void => { loop.stop(); throw new Error('stopped') })
    const loop = new GameLoop({ step: vi.fn(), render })
    loop.start()
    expect(() => frame()).toThrow('stopped')
    expect(frames.size).toBe(0)
    render.mockImplementation(() => {})
    loop.start(); frame()
    expect(frames.size).toBe(1)
  })
  it('caps background time and keeps rendering while simulation is paused', () => {
    const step = vi.fn(); const render = vi.fn()
    const loop = new GameLoop({ step, render })
    loop.start(); frame(3600)
    expect(step.mock.calls.length).toBeLessThanOrEqual(15)
    expect(render.mock.calls[0]![1]).toBe(0.25)
    loop.paused = true; step.mockClear()
    frame()
    expect(step).not.toHaveBeenCalled()
    expect(render.mock.calls.at(-1)![0]).toBe(1)
    expect(frames.size).toBe(1)
  })
})


describe('gamepad sampling before simulation', () => {
  function fixture() {
    const pad = { index: 0, id: 'pad', connected: true, axes: [0, 0, 0, 0], buttons: [{ pressed: false }] }
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
    vi.stubGlobal('document', { pointerLockElement: null })
    vi.stubGlobal('navigator', { getGamepads: () => [pad] })
    const input = new Input({} as HTMLCanvasElement)
    const consumed: boolean[] = []
    const beforeFrame = vi.fn((dt: number) => input.update(dt))
    const loop = new GameLoop({ beforeFrame, step: () => consumed.push(input.consume('jump')), render() {} })
    loop.start()
    return { pad, input, loop, consumed, beforeFrame }
  }
  it('makes A available in the first step, once even with multiple catch-up steps', () => {
    const f = fixture()
    try {
      f.pad.buttons[0]!.pressed = true
      frame(0.05)
      expect(f.beforeFrame).toHaveBeenCalledTimes(1)
      expect(f.consumed[0]).toBe(true)
      expect(f.consumed.filter(Boolean)).toHaveLength(1)
      expect(f.consumed.length).toBeGreaterThan(1)
    } finally { f.loop.stop(); f.input.dispose() }
  })
  it('retains a short tap across high-refresh frames without a simulation step', () => {
    const f = fixture()
    try {
      f.pad.buttons[0]!.pressed = true; frame(1 / 144)
      expect(f.consumed).toHaveLength(0)
      f.pad.buttons[0]!.pressed = false; frame(1 / 144)
      expect(f.consumed).toHaveLength(0)
      frame(1 / 144)
      expect(f.consumed).toEqual([true])
      frame(1 / 60)
      expect(f.consumed.filter(Boolean)).toHaveLength(1)
    } finally { f.loop.stop(); f.input.dispose() }
  })
  it('keeps polling while paused so menu confirmation remains available', () => {
    const f = fixture()
    try {
      f.loop.paused = true; f.pad.buttons[0]!.pressed = true; frame()
      expect(f.consumed).toHaveLength(0)
      expect(f.input.consume('jump')).toBe(true)
      expect(f.beforeFrame).toHaveBeenCalledTimes(1)
    } finally { f.loop.stop(); f.input.dispose() }
  })
})
