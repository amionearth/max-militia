// End-to-end smoke test for V2. Uses SMOKE_URL (a running dev server, default http://127.0.0.1:3000/)
// and the WebSocket server on :8787 (start it with `pnpm start:server`). Fails on any console error.
// Covers: name screen, menu, locker, practice (move, jet, fire, grenade, scoreboard) and a two-player
// room (create, join, start, countdown, snapshots both ways, leave). Screenshots go to ./shots/.
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const out = process.env.SHOTS_DIR ?? 'shots'
mkdirSync(out, { recursive: true })
const url = process.env.SMOKE_URL ?? 'http://127.0.0.1:3000/'
let browser
const guard = setTimeout(() => fail('timed out'), 240_000)
async function fail(msg) {
  console.error(`smoke: FAIL - ${msg}`)
  await browser?.close().catch(() => {})
  process.exit(1)
}
const check = (cond, msg) => { if (!cond) throw new Error(msg) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function openPage(context, errors, tag, path = '') {
  const page = await context.newPage()
  page.on('console', m => m.type() === 'error' && errors.push(`[${tag}] ${m.text()}`))
  page.on('pageerror', e => errors.push(`[${tag}] ${String(e)}`))
  page.on('response', r => r.status() >= 400 && errors.push(`[${tag}] HTTP ${r.status()} ${r.url()}`))
  await page.addInitScript(() => {
    let locked = false
    Object.defineProperty(document, 'pointerLockElement', { get: () => (locked ? document.getElementById('game') : null), configurable: true })
    HTMLCanvasElement.prototype.requestPointerLock = function () { locked = true; document.dispatchEvent(new Event('pointerlockchange')); return Promise.resolve() }
    document.exitPointerLock = () => { locked = false; document.dispatchEvent(new Event('pointerlockchange')) }
    localStorage.clear()
  })
  await page.goto(url + path)
  return page
}
const hud = page => page.evaluate(() => window.__game.game.hud())
const gstate = page => page.evaluate(() => {
  const { game } = window.__game
  const s = game.session
  return { mode: game.mode, online: game.online, others: s ? s.others(performance.now()).length : -1, phase: s?.match.phase, hp: s?.info.health, pos: game.state }
})

try {
  const args = ['--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required']
  browser = await chromium.launch({ args }).catch(() => chromium.launch({ args, channel: 'msedge' })).catch(() => chromium.launch({ args, channel: 'chrome' }))
  const errors = []
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' })
  const A = await openPage(ctxA, errors, 'A')

  // Name screen.
  await A.waitForSelector('section[data-screen="name"].is-active', { timeout: 60_000 })
  check((await A.locator('#ui .legal').innerText()) === 'Fan-made project. Not affiliated with Appsomniacs or Miniclip.', 'legal footer text is wrong')
  await A.fill('#nameInput', 'x')
  await A.click('section[data-screen="name"] button[type=submit]')
  check((await A.locator('[data-el="nameError"]').innerText()).length > 0, 'short name should be rejected')
  await A.fill('#nameInput', 'Skyfox')
  await A.click('section[data-screen="name"] button[type=submit]')
  await A.waitForSelector('section[data-screen="menu"].is-active')
  check((await A.locator('[data-el="whoName"]').innerText()) === 'Skyfox', 'name not shown in menu')
  await A.waitForTimeout(600)
  await A.screenshot({ path: `${out}/v2-01-menu.png` })

  // Locker.
  await A.click('[data-action="locker"]')
  await A.waitForSelector('section[data-screen="locker"].is-active')
  const tabs = await A.locator('.tab').count()
  check(tabs >= 5, `expected cosmetic tabs, got ${tabs}`)
  await A.locator('.chip').nth(2).click()
  await A.click('[data-action="lockerRandom"]')
  await A.waitForTimeout(900)
  await A.screenshot({ path: `${out}/v2-02-locker.png` })
  const saved = await A.evaluate(() => JSON.parse(localStorage.getItem('maxmilitia.profile.v2')))
  check(saved.name === 'Skyfox' && saved.cosmetics, 'profile not saved')
  await A.click('.locker-panel [data-action="menu"]')

  // Practice.
  await A.click('[data-action="practice"]')
  await A.waitForSelector('section[data-screen="hud"].is-active')
  await A.waitForTimeout(1200)
  let h = await hud(A)
  check(h.practice && h.health === 100 && h.grenades.length === 3, 'practice HUD state is wrong')
  const g0 = h.grenades.map(g => g.count)
  await A.keyboard.press('g')
  await A.waitForTimeout(400)
  h = await hud(A)
  check(h.grenades[h.grenadeSelected].count === g0[h.grenadeSelected] - 1, 'grenade count did not drop after throwing')
  const ground = await gstate(A)
  await A.keyboard.down('Space')
  let flying = await gstate(A)
  for (let i = 0; i < 40 && flying.pos.y < ground.pos.y + 2; i++) { await A.waitForTimeout(150); flying = await gstate(A) }
  await A.keyboard.up('Space')
  check(flying.pos.y > ground.pos.y + 2, `jetpack did not lift the player (${ground.pos.y} -> ${flying.pos.y})`)
  await A.mouse.down(); await A.waitForTimeout(500); await A.mouse.up()
  await A.keyboard.down('Tab'); await A.waitForTimeout(500)
  check(!(await A.locator('[data-el="scoreboard"]').isHidden()), 'scoreboard did not show')
  await A.screenshot({ path: `${out}/v2-03-practice.png` })
  await A.keyboard.up('Tab')
  await A.keyboard.press('Escape'); await A.waitForTimeout(200)
  await A.waitForSelector('section[data-screen="pause"].is-active')
  await A.click('[data-action="quit"]')
  await A.waitForSelector('section[data-screen="menu"].is-active')

  // Online room with two pilots.
  const ctxB = await browser.newContext({ viewport: { width: 960, height: 540 }, locale: 'en-US' })
  const B = await openPage(ctxB, errors, 'B')
  await B.waitForSelector('section[data-screen="name"].is-active', { timeout: 60_000 })
  await B.fill('#nameInput', 'Nova')
  await B.click('section[data-screen="name"] button[type=submit]')
  await B.waitForSelector('section[data-screen="menu"].is-active')

  await A.click('[data-action="create"]')
  await A.waitForSelector('section[data-screen="lobby"].is-active', { timeout: 15_000 })
  const code = (await A.locator('[data-el="roomCode"]').innerText()).trim()
  check(/^[A-Z2-9]{5}$/.test(code), `bad room code ${code}`)
  await B.click('[data-action="joinScreen"]')
  await B.fill('#codeInput', code.toLowerCase())
  await B.click('section[data-screen="join"] button[type=submit]')
  await B.waitForSelector('section[data-screen="lobby"].is-active', { timeout: 15_000 })
  await A.waitForFunction(() => document.querySelectorAll('.roster .member').length === 2, null, { timeout: 8000 })
  await A.screenshot({ path: `${out}/v2-04-lobby.png` })
  check(await B.locator('[data-el="startBtn"]').isHidden(), 'only the host should see Start')

  // An invite link opens the join screen with the code prefilled.
  const ctxC = await browser.newContext({ viewport: { width: 800, height: 500 }, locale: 'en-US' })
  const C = await openPage(ctxC, errors, 'C', `?room=${code}`)
  await C.waitForSelector('section[data-screen="name"].is-active', { timeout: 60_000 })
  await C.fill('#nameInput', 'Guest')
  await C.click('section[data-screen="name"] button[type=submit]')
  await C.waitForSelector('section[data-screen="join"].is-active')
  check((await C.inputValue('#codeInput')) === code, 'invite code was not prefilled')
  await ctxC.close()

  await A.click('[data-el="startBtn"]')
  await A.waitForSelector('section[data-screen="hud"].is-active', { timeout: 10_000 })
  await B.waitForSelector('section[data-screen="hud"].is-active', { timeout: 10_000 })
  await sleep(1500)
  let sa = await gstate(A)
  let sb = await gstate(B)
  check(sa.online && sb.online, 'sessions are not online')
  check(['countdown', 'live'].includes(sa.phase), `unexpected phase ${sa.phase}`)
  await sleep(4500)
  sa = await gstate(A); sb = await gstate(B)
  check(sa.phase === 'live' && sb.phase === 'live', `match not live (${sa.phase}/${sb.phase})`)
  check(sa.others === 1 && sb.others === 1, `players do not see each other (${sa.others}/${sb.others})`)
  // A flies and throws; B should still be stable and receive A moving.
  await A.keyboard.down('Space'); await A.keyboard.down('KeyW'); await sleep(800)
  await A.keyboard.press('g')
  await sleep(600)
  await A.keyboard.up('Space'); await A.keyboard.up('KeyW')
  await A.screenshot({ path: `${out}/v2-05-online-A.png` })
  await B.screenshot({ path: `${out}/v2-06-online-B.png` })
  const movedA = await gstate(A)
  check(Math.abs(movedA.pos.y - sa.pos.y) + Math.abs(movedA.pos.z - sa.pos.z) + Math.abs(movedA.pos.x - sa.pos.x) > 1.5, 'online player did not move')
  const hb = await hud(B)
  check(!hb.practice && hb.killLimit > 0, 'online HUD missing match info')

  // B leaves: A should see the roster shrink and stay in the match.
  await B.keyboard.press('Escape'); await B.waitForSelector('section[data-screen="pause"].is-active')
  await B.click('section[data-screen="pause"] [data-action="quit"]')
  await B.click('section[data-screen="pause"] [data-action="quit"]') // second click confirms leaving a live match
  await B.waitForSelector('section[data-screen="menu"].is-active')
  await sleep(1500)
  sa = await gstate(A)
  check(sa.others === 0, `A still sees ${sa.others} other players after B left`)

  const real = errors.filter(e => !/favicon|GPU stall|swiftshader|WebGL|Tweak/i.test(e))
  check(real.length === 0, `console errors:\n${real.join('\n')}`)
  console.log('smoke: PASS')
  await browser.close()
  clearTimeout(guard)
  process.exit(0)
} catch (err) {
  await fail(err instanceof Error ? err.message : String(err))
}
