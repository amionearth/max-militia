import './styles/main.css'
import { Audio } from './engine/audio'
import { Input } from './engine/input'
import { GameLoop } from './engine/loop'
import type { Game } from './game/game'
import { RoomClient } from './net/room'
import { Ui } from './ui/ui'

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!
  const input = new Input(canvas)
  const audio = new Audio()
  const room = new RoomClient()
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  let game: Game | undefined
  let lockLostAt = 0
  let leaving = false
  let boardTick = 0

  const beginHud = () => {
    ui.show('hud')
    loop.resetAccumulator()
    input.lockPointer()
  }
  const startPractice = () => {
    if (!game) return
    audio.unlock()
    audio.play('ui')
    game.startPractice(ui.profile.name, ui.profile.cosmetics)
    ui.setPauseInfo(false)
    beginHud()
  }
  const startOnline = () => {
    if (!game) return
    audio.unlock()
    game.startOnline(room, ui.profile.name, ui.profile.cosmetics)
    ui.setPauseInfo(true)
    beginHud()
  }
  const toMenu = (screen: 'menu' | 'lobby' = 'menu') => {
    game?.showTitle()
    ui.show(screen)
    input.unlockPointer()
  }
  const pause = () => {
    if (game?.mode !== 'playing') return
    game.pause()
    ui.setPauseInfo(game.online)
    ui.show('pause')
    input.unlockPointer()
  }
  const resume = () => {
    if (game?.mode !== 'paused') return
    audio.unlock()
    game.resume()
    ui.show('hud')
    loop.resetAccumulator()
    input.lockPointer()
  }
  const connect = (action: Promise<void>) => {
    leaving = false
    audio.unlock()
    action.then(
      () => { if (!game?.online) ui.show('lobby') },
      (err: Error) => ui.showMenuError(err.message || 'Could not connect.'),
    )
  }

  const ui = new Ui({
    practice: startPractice,
    audio: (volume, muted) => audio.setVolume(volume, muted),
    create: () => connect(room.create(ui.profile.name, ui.profile.cosmetics)),
    join: code => connect(room.join(code, ui.profile.name, ui.profile.cosmetics)),
    start: () => room.start(),
    settings: s => room.updateSettings(s),
    leaveRoom: () => {
      leaving = true
      room.leave()
      toMenu('menu')
    },
    openLocker: () => game?.showLocker(ui.profile.cosmetics, 0),
    lockerChange: c => game?.setCosmetics(c),
    lockerEmote: () => game?.lockerEmote(),
    lockerDrag: dx => game?.lockerDrag(dx),
    resume,
    quitToMenu: () => {
      if (game?.online) { leaving = true; room.leave() }
      toMenu('menu')
    },
  })
  ui.setBootProgress(0.15, 'Loading engine…')

  room.onLobby = () => {
    ui.updateLobby(room)
    if (!game) return
    if (room.state === 'match' && !game.online) startOnline()
    else if (room.state === 'lobby' && game.online) toMenu('lobby')
  }
  room.onResults = info => {
    if (!game?.online) return
    ui.showResults(info, game.hud().team)
    input.unlockPointer()
  }
  room.onError = (_code, message) => {
    if (ui.screen === 'lobby') ui.lobbyError(message)
    else ui.toast(message)
  }
  room.onStatus = status => ui.setConn(status)
  room.onLeft = reason => {
    if (leaving) { leaving = false; return }
    toMenu('menu')
    ui.toast(reason)
  }

  // The static boot screen is already visible; three.js and the game load as a separate chunk.
  let loaded = 0
  const track = <T>(p: Promise<T>, text: string): Promise<T> => p.then(v => (ui.setBootProgress(0.15 + (++loaded / 3) * 0.8, text), v))
  const [{ Game }, { Renderer, suggestQuality }] = await Promise.all([
    track(import('./game/game'), 'Building arena…'),
    track(import('./engine/renderer'), 'Starting renderer…'),
    track(document.fonts.ready, 'Loading fonts…'),
  ])

  const renderer = new Renderer(canvas, suggestQuality())
  game = new Game(renderer, input, audio, {
    hit: kind => { ui.hit(kind) },
    damage: angle => ui.damage(angle),
    death: (show, reason) => ui.death(show, reason),
    feed: entry => ui.feed(entry),
    banner: text => ui.banner(text),
    phase: phase => ui.phase(phase),
  }, ui.profile.cosmetics)
  game.reducedMotion = reducedMotion
  if (import.meta.env.DEV) {
    const [{ registerGameTuning }, { tuning }] = await Promise.all([
      import('../scripts/manus-tuning/adapter.js'), import('./game/tuning'),
    ])
    await registerGameTuning(tuning)
  }
  const g = game

  const loop = new GameLoop({
    beforeFrame: frameSeconds => input.update(frameSeconds),
    step: dt => g.step(dt),
    render: (alpha, frameSeconds) => {
      if (input.consume('pause') && performance.now() - lockLostAt > 300) {
        if (g.mode === 'playing') pause()
        else if (g.mode === 'paused' && ui.screen === 'pause') resume()
      }
      // Online matches keep simulating while the menu is open.
      loop.paused = g.mode === 'paused' && !g.online
      // Leaving the locker through the menu buttons restores the title camera.
      if (g.mode === 'locker' && ui.screen !== 'locker') g.showTitle()
      g.render(alpha, frameSeconds)
      if (g.mode === 'playing' || g.mode === 'paused' || g.mode === 'results') {
        ui.updateHud(g.hud())
        ui.setLockHint(g.mode === 'playing' && document.pointerLockElement !== canvas)
        const wantBoard = g.mode === 'playing' && input.held('scoreboard')
        boardTick -= frameSeconds
        if (!wantBoard || boardTick <= 0) {
          boardTick = 0.25
          ui.updateScoreboard(wantBoard, wantBoard ? g.scoreboard() : [])
        }
      }
    },
  })
  loop.start()

  document.addEventListener('pointerlockchange', () => {
    // Browsers release pointer lock on Escape without delivering the key: treat that as pause.
    if (!document.pointerLockElement && g.mode === 'playing') {
      lockLostAt = performance.now()
      pause()
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause()
  })
  canvas.addEventListener('click', () => {
    if (g.mode === 'playing') input.lockPointer()
  })

  ui.setBootProgress(1, 'Ready')
  window.setTimeout(() => ui.enter(), 250)
  // Debug/test hook (read-only use): smoke tests inspect game state through it.
  ;(window as unknown as { __game: unknown }).__game = { game: g, ui, input, room }
}

boot().catch(err => {
  console.error(err)
  document.getElementById('boot')?.classList.add('done')
  const el = document.getElementById('ui')
  if (el) el.innerHTML = `<div class="fatal">Failed to start: ${String((err as Error)?.message ?? err).replace(/[<>&]/g, '')}</div>`
})
