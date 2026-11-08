// Jetpack tuning simulation v2: partial burst recovery between taps.
const dt = 1 / 60
function sim(cfg, pattern) {
  const g = -26
  let fuel = 100, hold = 0, y = 0, v = cfg.jump, maxY = 0, t = 0, locked = false, air = 0, thrustTime = 0
  while (t < 12 && y >= 0) {
    const want = air > 0.12 && pattern(air - 0.12)
    let a = 0
    if (want && !locked && fuel > 0) {
      hold += dt
      thrustTime += dt
      fuel = Math.max(0, fuel - cfg.drain * dt)
      if (fuel <= 0) locked = true
      const settle = Math.max(0, 1 - hold / cfg.burstSeconds)
      a = cfg.sustain + (cfg.burst - cfg.sustain) * settle
    } else hold = Math.max(0, hold - dt * cfg.recover)
    if (!want) locked = false
    v += (g + a) * dt
    if (a > 0 && v > cfg.maxRise) v = cfg.maxRise
    y += v * dt
    maxY = Math.max(maxY, y)
    air += dt
    t += dt
  }
  return `peak ${maxY.toFixed(1)} m, fuel left ${fuel.toFixed(0)}, thrust ${thrustTime.toFixed(1)}s`
}
const pulse = (on, off) => t => (t % (on + off)) < on
for (const cfg of [
  { name: 'A sustain21 b56 bs.5 rec1', jump: 9.5, drain: 35, burst: 56, sustain: 21, burstSeconds: 0.5, maxRise: 11, recover: 1 },
  { name: 'B sustain20 b54 bs.5 rec1.5', jump: 9.5, drain: 35, burst: 54, sustain: 20, burstSeconds: 0.5, maxRise: 11, recover: 1.5 },
  { name: 'C sustain22 b54 bs.45 rec2', jump: 9.5, drain: 35, burst: 54, sustain: 22, burstSeconds: 0.45, maxRise: 11, recover: 2 },
]) {
  console.log(cfg.name)
  console.log('  hold          ', sim(cfg, () => true))
  for (const [on, off] of [[0.15, 0.15], [0.2, 0.2], [0.25, 0.25], [0.3, 0.3], [0.4, 0.4], [0.2, 0.4]]) {
    console.log(`  pulse ${on}/${off}`.padEnd(16), sim(cfg, pulse(on, off)))
  }
}
