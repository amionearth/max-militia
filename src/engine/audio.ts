/**
 * Web Audio mixer. Every sound is synthesized (oscillators and filtered noise), so the game ships
 * no audio files. Browsers only allow audio after a user gesture: `unlock()` is called from Play.
 * The jetpack is a looping filtered-noise voice whose gain and filter follow thrust.
 */
export type Sfx =
  | 'uzi' | 'deagle' | 'empty' | 'reload_out' | 'reload_in' | 'swap'
  | 'hit' | 'headshot' | 'kill' | 'jump' | 'land' | 'respawn' | 'down' | 'ui'
  | 'ak47' | 'shotgun' | 'sniper' | 'magnum'
  | 'throw' | 'boom' | 'gas' | 'beep' | 'armed' | 'pickup' | 'item'
  | 'count' | 'go' | 'win' | 'lose' | 'emote' | 'hurt'

export class Audio {
  readonly ctx: AudioContext
  private readonly master: GainNode
  private readonly sfx: GainNode
  private readonly noiseBuffer: AudioBuffer
  private jetGain!: GainNode
  private jetFilter!: BiquadFilterNode
  private jetRumble!: GainNode
  private jetStarted = false
  private lastShot = 0
  /** Per-call volume multiplier (distance falloff), applied by tone() and noise(). */
  private v = 1

  constructor() {
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.sfx = this.ctx.createGain()
    this.sfx.gain.value = 0.8
    this.sfx.connect(this.master)
    const limiter = this.ctx.createDynamicsCompressor()
    limiter.threshold.value = -10
    limiter.ratio.value = 8
    this.master.connect(limiter).connect(this.ctx.destination)
    const length = this.ctx.sampleRate * 2
    this.noiseBuffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate)
    const data = this.noiseBuffer.getChannelData(0)
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
  }

  unlock(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    this.startJet()
  }

  /** Volume in 0..1. */
  setVolume(volume: number, muted = false): void {
    this.master.gain.setTargetAtTime(muted ? 0 : volume, this.ctx.currentTime, 0.05)
  }

  private startJet(): void {
    if (this.jetStarted) return
    this.jetStarted = true
    const src = this.ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    src.loop = true
    this.jetFilter = this.ctx.createBiquadFilter()
    this.jetFilter.type = 'bandpass'
    this.jetFilter.frequency.value = 500
    this.jetFilter.Q.value = 0.8
    this.jetGain = this.ctx.createGain()
    this.jetGain.gain.value = 0
    src.connect(this.jetFilter).connect(this.jetGain).connect(this.sfx)
    src.start()
    // Low rumble layer.
    const osc = this.ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = 62
    const low = this.ctx.createBiquadFilter()
    low.type = 'lowpass'
    low.frequency.value = 180
    this.jetRumble = this.ctx.createGain()
    this.jetRumble.gain.value = 0
    osc.connect(low).connect(this.jetRumble).connect(this.sfx)
    osc.start()
  }

  /** Thrust level 0..1. Gain and filter brightness rise with thrust: a whoosh that opens up. */
  setJet(level: number): void {
    if (!this.jetStarted) return
    const t = this.ctx.currentTime
    this.jetGain.gain.setTargetAtTime(level * 0.42, t, 0.04)
    this.jetFilter.frequency.setTargetAtTime(380 + level * 1500, t, 0.05)
    this.jetRumble.gain.setTargetAtTime(level * 0.12, t, 0.06)
  }

  private tone(freq: number, end: number, dur: number, type: OscillatorType, vol: number, delay = 0): void {
    const t = this.ctx.currentTime + delay
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    o.frequency.exponentialRampToValueAtTime(Math.max(end, 20), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * this.v), t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(this.sfx)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  private noise(dur: number, type: BiquadFilterType, freq: number, vol: number, delay = 0, q = 0.7): void {
    const t = this.ctx.currentTime + delay
    const src = this.ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    const f = this.ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(Math.max(0.0002, vol * this.v), t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(f).connect(g).connect(this.sfx)
    src.start(t, Math.random() * 1.5)
    src.stop(t + dur + 0.02)
  }

  /** Play a one-shot. `volume` (0..1) is used for distance falloff of remote sounds. */
  play(name: Sfx, volume = 1): void {
    if (this.ctx.state !== 'running' || volume <= 0.01) return
    this.v = volume
    this.playInner(name)
    this.v = 1
  }

  private playInner(name: Sfx): void {
    switch (name) {
      case 'uzi': {
        // Limit voices at very high fire rates.
        const now = this.ctx.currentTime
        if (now - this.lastShot < 0.035) return
        this.lastShot = now
        this.noise(0.07, 'highpass', 1500, 0.55)
        this.tone(190, 70, 0.07, 'square', 0.22)
        break
      }
      case 'deagle':
        this.noise(0.2, 'bandpass', 1100, 0.85, 0, 0.5)
        this.noise(0.35, 'lowpass', 420, 0.7)
        this.tone(130, 38, 0.22, 'sine', 0.6)
        break
      case 'empty': this.tone(1500, 900, 0.03, 'square', 0.1); break
      case 'reload_out':
        this.noise(0.05, 'bandpass', 2400, 0.4, 0, 3)
        this.tone(320, 180, 0.07, 'square', 0.1)
        break
      case 'reload_in':
        this.noise(0.05, 'bandpass', 1800, 0.5, 0, 3)
        this.tone(220, 330, 0.08, 'square', 0.12)
        this.tone(520, 260, 0.06, 'square', 0.1, 0.07)
        break
      case 'swap': this.noise(0.06, 'bandpass', 3000, 0.25, 0, 2); this.tone(400, 700, 0.05, 'triangle', 0.1); break
      case 'hit': this.tone(1900, 1500, 0.04, 'sine', 0.22); break
      case 'headshot': this.tone(2600, 2000, 0.06, 'sine', 0.3); this.tone(1300, 1000, 0.08, 'triangle', 0.2); break
      case 'kill': this.tone(900, 300, 0.25, 'sawtooth', 0.18); this.tone(1800, 600, 0.18, 'sine', 0.2); break
      case 'jump': this.noise(0.12, 'bandpass', 700, 0.18, 0, 1); break
      case 'land': this.tone(150, 55, 0.12, 'sine', 0.35); this.noise(0.08, 'lowpass', 400, 0.3); break
      case 'respawn': this.tone(260, 780, 0.35, 'triangle', 0.22); this.tone(520, 1560, 0.3, 'sine', 0.12, 0.08); break
      case 'down': this.tone(420, 70, 0.7, 'sawtooth', 0.22); this.noise(0.4, 'lowpass', 600, 0.3); break
      case 'ui': this.tone(660, 780, 0.06, 'triangle', 0.16); break
      case 'ak47':
        this.noise(0.1, 'bandpass', 1300, 0.6, 0, 0.6)
        this.tone(150, 55, 0.1, 'sawtooth', 0.3)
        break
      case 'shotgun':
        this.noise(0.28, 'lowpass', 900, 0.95)
        this.noise(0.12, 'highpass', 1800, 0.5)
        this.tone(95, 32, 0.3, 'sine', 0.7)
        this.noise(0.08, 'bandpass', 2600, 0.3, 0.35, 3)
        break
      case 'sniper':
        this.noise(0.45, 'bandpass', 700, 0.9, 0, 0.4)
        this.tone(300, 40, 0.35, 'sawtooth', 0.45)
        this.tone(1800, 200, 0.5, 'sine', 0.12, 0.02)
        break
      case 'magnum':
        this.noise(0.26, 'bandpass', 900, 0.95, 0, 0.5)
        this.tone(110, 30, 0.3, 'sine', 0.75)
        this.tone(240, 60, 0.12, 'square', 0.18)
        break
      case 'throw': this.noise(0.14, 'bandpass', 900, 0.22, 0, 1.2); this.tone(260, 520, 0.1, 'triangle', 0.1); break
      case 'boom':
        this.noise(0.7, 'lowpass', 500, 1)
        this.tone(90, 28, 0.6, 'sine', 0.9)
        this.noise(0.2, 'highpass', 1500, 0.4)
        break
      case 'gas': this.noise(0.6, 'bandpass', 1800, 0.35, 0, 0.5); this.tone(480, 220, 0.3, 'triangle', 0.1); break
      case 'beep': this.tone(1500, 1500, 0.04, 'square', 0.12); break
      case 'armed': this.tone(900, 1300, 0.08, 'square', 0.14); this.tone(1300, 1300, 0.06, 'square', 0.12, 0.1); break
      case 'pickup': this.tone(520, 1040, 0.12, 'triangle', 0.22); this.tone(780, 1560, 0.14, 'sine', 0.16, 0.07); break
      case 'item': this.tone(1200, 1800, 0.08, 'sine', 0.1); break
      case 'count': this.tone(660, 660, 0.12, 'square', 0.16); break
      case 'go': this.tone(660, 1320, 0.3, 'square', 0.18); this.tone(990, 1980, 0.3, 'triangle', 0.14); break
      case 'win': this.tone(520, 520, 0.14, 'triangle', 0.2); this.tone(660, 660, 0.14, 'triangle', 0.2, 0.15); this.tone(880, 880, 0.3, 'triangle', 0.22, 0.3); break
      case 'lose': this.tone(330, 220, 0.3, 'sawtooth', 0.16); this.tone(220, 110, 0.5, 'sawtooth', 0.16, 0.25); break
      case 'emote': this.tone(700, 900, 0.07, 'triangle', 0.1); this.tone(900, 700, 0.07, 'triangle', 0.1, 0.09); break
      case 'hurt': this.tone(200, 90, 0.12, 'sawtooth', 0.25); this.noise(0.08, 'lowpass', 500, 0.3); break
    }
  }
}
