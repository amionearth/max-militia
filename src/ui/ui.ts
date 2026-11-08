/**
 * All DOM UI. Screens: boot, name, menu, locker (customization), join, lobby, hud, pause, results.
 * Player-provided text (names, room codes) is only ever written with textContent / value, never as
 * HTML, so a hostile name cannot inject markup. The game never touches the DOM; `main.ts` pushes
 * state in once per frame.
 */
import type { FeedEntry, HitKind, HudInfo } from '../game/game'
import type { MatchPhase } from '../shared/match'
import { DEFAULT_COSMETICS, NAME_MAX, NAME_MIN, SLOT_LABELS, SLOT_OPTIONS, SLOT_ORDER, randomCosmetics, sanitizeCosmetics, sanitizeName, type CosmeticSlot, type Cosmetics } from '../shared/cosmetics'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode, type RoomSettings } from '../shared/protocol'
import matchData from '../data/match.json'
import type { ConnStatus, RoomClient, ResultsInfo } from '../net/room'
import type { ScoreRow } from '../net/session'

export type Screen = 'boot' | 'name' | 'menu' | 'locker' | 'join' | 'lobby' | 'hud' | 'pause' | 'results'
export type UiActions = {
  practice(): void
  audio(volume: number, muted: boolean): void
  create(): void
  join(code: string): void
  start(): void
  settings(s: RoomSettings): void
  leaveRoom(): void
  openLocker(): void
  lockerChange(c: Cosmetics): void
  lockerEmote(): void
  lockerDrag(dx: number): void
  resume(): void
  quitToMenu(): void
}

export const LEGAL = 'Fan-made project. Not affiliated with Appsomniacs or Miniclip.'
const STORE_KEY = 'maxmilitia.profile.v2'
const AUDIO_KEY = 'maxmilitia.audio.v2'
const TEAM_NAMES = ['RED', 'BLUE']
const TEAM_CLASS = ['red', 'blue']

const CONTROLS: [string, string][] = [
  ['W A S D', 'Move'],
  ['Mouse', 'Aim'],
  ['Left click', 'Fire'],
  ['Space', 'Jump, hold in air for jetpack'],
  ['Shift', 'Sprint'],
  ['R', 'Reload'],
  ['1 / 2 / wheel', 'Switch weapon'],
  ['G or right click', 'Throw grenade'],
  ['3 / 4 / 5 or Q', 'Pick grenade type'],
  ['V', 'Emote'],
  ['Tab (hold)', 'Scoreboard'],
  ['Esc', 'Menu'],
]
const HINT = 'WASD move · Click fire · G grenade · 3 4 5 / Q type · Space jet · R reload · 1 2 wheel weapon · V emote · Tab scores · Esc menu'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

export type Profile = { name: string; cosmetics: Cosmetics }

export function loadProfile(): Profile {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { name?: unknown; cosmetics?: unknown } | null
    return { name: sanitizeName(raw?.name) ?? '', cosmetics: sanitizeCosmetics(raw?.cosmetics) }
  } catch {
    return { name: '', cosmetics: { ...DEFAULT_COSMETICS } }
  }
}

function saveProfile(p: Profile): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(p)) } catch { /* private mode: ignore */ }
}

export class Ui {
  screen: Screen = 'boot'
  profile: Profile = loadProfile()
  private audioPrefs = { volume: 0.8, muted: false }
  private online = false
  private leaveArmed = 0
  /** Room code from an invite link (?room=CODE), if any. */
  private inviteCode = ''
  private readonly root: HTMLElement
  private readonly els = {} as Record<string, HTMLElement>
  private hitTimer = 0
  private bannerTimer = 0
  private toastTimer = 0
  private lockerSlot: CosmeticSlot = SLOT_ORDER[0]
  private last = { health: -1, fuel: -1, ammo: -1, weapon: '', clip: -1, timer: '', scores: '', grenades: '' }
  private lastLobby = ''

  constructor(private readonly actions: UiActions) {
    this.root = document.getElementById('ui')!
    try {
      const a = JSON.parse(localStorage.getItem(AUDIO_KEY) ?? 'null') as { volume?: unknown; muted?: unknown } | null
      if (a && typeof a.volume === 'number' && a.volume >= 0 && a.volume <= 1) this.audioPrefs.volume = a.volume
      if (a && a.muted === true) this.audioPrefs.muted = true
    } catch { /* ignore */ }
    this.inviteCode = normalizeRoomCode(new URLSearchParams(location.search).get('room')) ?? ''
    const controls = CONTROLS.map(([k, v]) => `<li><kbd>${k}</kbd><span>${v}</span></li>`).join('')
    this.root.insertAdjacentHTML('beforeend', `
      <section class="screen menu-screen" data-screen="name" hidden>
        <div class="title-card">
          <h1 class="logo"><span class="logo-max">MAX</span> <span class="logo-mil">MILITIA</span></h1>
          <p class="tagline">Pick your callsign, pilot.</p>
          <form class="form" data-el="nameForm" autocomplete="off">
            <label for="nameInput">Callsign (${NAME_MIN}-${NAME_MAX} characters)</label>
            <input id="nameInput" data-el="nameInput" class="text" type="text" maxlength="${NAME_MAX}" spellcheck="false" placeholder="e.g. Skyfox" />
            <p class="error" data-el="nameError" role="alert"></p>
            <button class="btn primary" type="submit">CONTINUE</button>
          </form>
        </div>
      </section>

      <section class="screen menu-screen" data-screen="menu" hidden>
        <div class="title-card">
          <h1 class="logo"><span class="logo-max">MAX</span> <span class="logo-mil">MILITIA</span></h1>
          <p class="tagline">Jetpack gunfights above the neon sky.</p>
          <p class="who">Pilot: <strong data-el="whoName"></strong> <button class="link" data-action="rename" type="button">change</button></p>
          <button class="btn primary" data-action="practice" type="button">PRACTICE RANGE</button>
          <button class="btn" data-action="create" type="button">CREATE ROOM</button>
          <button class="btn" data-action="joinScreen" type="button">JOIN ROOM</button>
          <button class="btn" data-action="locker" type="button">CUSTOMIZE</button>
          <p class="error" data-el="menuError" role="alert"></p>
          <p class="note" data-el="menuNote">Online rooms hold up to 6 pilots in team deathmatch.</p>
        </div>
      </section>

      <section class="screen menu-screen" data-screen="join" hidden>
        <div class="title-card">
          <h2>JOIN ROOM</h2>
          <form class="form" data-el="joinForm" autocomplete="off">
            <label for="codeInput">Room code (${ROOM_CODE_LENGTH} characters)</label>
            <input id="codeInput" data-el="codeInput" class="text code" type="text" maxlength="${ROOM_CODE_LENGTH}" spellcheck="false" placeholder="ABCDE" />
            <p class="error" data-el="joinError" role="alert"></p>
            <button class="btn primary" type="submit" data-el="joinBtn">JOIN</button>
          </form>
          <button class="btn" data-action="menu" type="button">BACK</button>
        </div>
      </section>

      <section class="screen locker" data-screen="locker" hidden>
        <aside class="locker-panel">
          <h2>CUSTOMIZE</h2>
          <nav class="tabs" data-el="lockerTabs"></nav>
          <div class="chips" data-el="lockerChips"></div>
          <div class="row">
            <button class="btn small" data-action="lockerRandom" type="button">RANDOM</button>
            <button class="btn small" data-action="lockerEmote" type="button">PLAY EMOTE</button>
          </div>
          <button class="btn primary" data-action="menu" type="button">DONE</button>
          <p class="note">Drag the preview to rotate. Changes save automatically.</p>
        </aside>
        <div class="drag-zone" data-el="dragZone"></div>
      </section>

      <section class="screen menu-screen" data-screen="lobby" hidden>
        <div class="title-card wide">
          <p class="note">ROOM CODE</p>
          <div class="room-code"><span data-el="roomCode">-----</span><button class="link" data-action="copyCode" type="button">copy</button></div>
          <p class="note"><button class="link" data-action="copyLink" type="button">Copy invite link</button> and send it to your friends.</p>
          <ul class="roster" data-el="roster"></ul>
          <div class="settings" data-el="settings">
            <label>Kill limit <select data-el="killLimit"></select></label>
            <label>Time limit <select data-el="timeLimit"></select></label>
          </div>
          <p class="error" data-el="lobbyError" role="alert"></p>
          <p class="note" data-el="lobbyNote"></p>
          <button class="btn primary" data-action="start" data-el="startBtn" type="button">START MATCH</button>
          <button class="btn" data-action="leaveRoom" type="button">LEAVE ROOM</button>
        </div>
      </section>

      <section class="screen pause" data-screen="pause" hidden>
        <div class="title-card small">
          <h2>MENU</h2>
          <p class="note" data-el="pauseNote"></p>
          <button class="btn primary" data-action="resume" type="button">RESUME</button>
          <button class="btn" data-action="quit" data-el="quitBtn" type="button">BACK TO MENU</button>
          <ul class="controls">${controls}</ul>
        </div>
      </section>

      <section class="screen results" data-screen="results" hidden>
        <div class="title-card small wide">
          <h2 data-el="resultTitle">MATCH OVER</h2>
          <p class="result-score" data-el="resultScore"></p>
          <table class="board"><thead><tr><th>Pilot</th><th>Team</th><th>K</th><th>D</th></tr></thead><tbody data-el="resultRows"></tbody></table>
          <p class="note">Returning to the lobby shortly…</p>
          <button class="btn" data-action="leaveRoom" type="button">LEAVE ROOM</button>
        </div>
      </section>

      <section class="screen hud" data-screen="hud" hidden>
        <div class="matchbar" data-el="matchBar">
          <span class="score red" data-el="scoreRed">0</span>
          <span class="clock" data-el="clock">--:--</span>
          <span class="score blue" data-el="scoreBlue">0</span>
          <small data-el="matchSub"></small>
        </div>
        <div class="feed" data-el="feed"></div>
        <div class="banner" data-el="banner"></div>
        <div class="crosshair" data-el="crosshair"><i></i><i></i><i></i><i></i><b></b><em data-el="marker"></em></div>
        <div class="dmg" data-el="dmg"></div>
        <div class="reload-text" data-el="reloadText"></div>
        <div class="pickup-hint" data-el="pickupHint"></div>
        <div class="vitals">
          <div class="bar hp"><label>HP</label><div class="track"><div class="fill" data-el="hpFill"></div></div><output data-el="hpText">100</output></div>
          <div class="bar fuel" data-el="fuelBar"><label>FUEL</label><div class="track"><div class="fill" data-el="fuelFill"></div></div><output data-el="fuelText">100</output></div>
        </div>
        <div class="weapon">
          <div class="grenades" data-el="grenades"></div>
          <div class="weapon-name" data-el="weaponName">UZI</div>
          <div class="ammo"><span data-el="ammo">40</span><small data-el="clip">/ 40</small></div>
          <div class="reload-track"><div data-el="reloadFill"></div></div>
        </div>
        <div class="hint">${HINT}</div>
        <div class="net" data-el="net"></div>
        <div class="lockhint" data-el="lockHint" hidden>CLICK TO CAPTURE THE MOUSE</div>
        <div class="respawn" data-el="respawn" hidden>
          <h2 data-el="deathTitle">DOWN</h2>
          <p>Respawning in <strong data-el="respawnTime">3</strong></p>
        </div>
        <div class="scoreboard" data-el="scoreboard" hidden>
          <table class="board"><thead><tr><th>Pilot</th><th>Team</th><th>K</th><th>D</th></tr></thead><tbody data-el="scoreRows"></tbody></table>
        </div>
      </section>

      <div class="toast" data-el="toast" role="status" hidden></div>
      <div class="audio-box" data-el="audioBox" hidden>
        <label><input type="checkbox" data-el="muteBox" /> Mute</label>
        <label>Volume <input type="range" min="0" max="100" step="5" data-el="volumeRange" aria-label="Master volume" /></label>
      </div>
      <div class="conn" data-el="conn" hidden></div>
      <footer class="legal">${LEGAL}</footer>
    `)
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach(e => { this.els[e.dataset.el!] = e })
    this.buildSettingsOptions()
    this.buildLocker()
    this.wire()
    this.show('boot')
  }

  // ---- wiring ---------------------------------------------------------------------------------
  private wire(): void {
    this.root.addEventListener('click', e => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action
      if (!action) return
      this.handleAction(action)
    })
    const nameForm = this.els.nameForm as HTMLFormElement
    nameForm.addEventListener('submit', ev => {
      ev.preventDefault()
      const name = sanitizeName((this.els.nameInput as HTMLInputElement).value)
      if (!name) { this.els.nameError.textContent = `Use ${NAME_MIN}-${NAME_MAX} letters, numbers, spaces, - or _.`; return }
      this.els.nameError.textContent = ''
      this.profile.name = name
      saveProfile(this.profile)
      this.afterName()
    })
    const joinForm = this.els.joinForm as HTMLFormElement
    const codeInput = this.els.codeInput as HTMLInputElement
    codeInput.addEventListener('input', () => {
      codeInput.value = [...codeInput.value.toUpperCase()].filter(c => ROOM_CODE_ALPHABET.includes(c)).join('').slice(0, ROOM_CODE_LENGTH)
    })
    joinForm.addEventListener('submit', ev => {
      ev.preventDefault()
      const code = normalizeRoomCode(codeInput.value)
      if (!code) { this.els.joinError.textContent = `Enter the ${ROOM_CODE_LENGTH}-character code from your host.`; return }
      this.els.joinError.textContent = ''
      this.setBusy(true)
      this.actions.join(code)
    })
    // Drag to rotate the preview in the locker.
    const zone = this.els.dragZone
    let dragging = false
    let lastX = 0
    zone.addEventListener('pointerdown', e => { dragging = true; lastX = e.clientX; zone.setPointerCapture(e.pointerId) })
    zone.addEventListener('pointermove', e => { if (dragging) { this.actions.lockerDrag(e.clientX - lastX); lastX = e.clientX } })
    zone.addEventListener('pointerup', () => { dragging = false })
    zone.addEventListener('pointercancel', () => { dragging = false })
    const kl = this.els.killLimit as HTMLSelectElement
    const tl = this.els.timeLimit as HTMLSelectElement
    const push = () => this.actions.settings({ killLimit: Number(kl.value), timeLimitMinutes: Number(tl.value) })
    kl.addEventListener('change', push)
    tl.addEventListener('change', push)
    const mute = this.els.muteBox as HTMLInputElement
    const vol = this.els.volumeRange as HTMLInputElement
    mute.checked = this.audioPrefs.muted
    vol.value = String(Math.round(this.audioPrefs.volume * 100))
    const applyAudio = () => {
      this.audioPrefs = { volume: Number(vol.value) / 100, muted: mute.checked }
      try { localStorage.setItem(AUDIO_KEY, JSON.stringify(this.audioPrefs)) } catch { /* ignore */ }
      this.actions.audio(this.audioPrefs.volume, this.audioPrefs.muted)
    }
    mute.addEventListener('change', applyAudio)
    vol.addEventListener('input', applyAudio)
    this.actions.audio(this.audioPrefs.volume, this.audioPrefs.muted)
  }

  private handleAction(action: string): void {
    switch (action) {
      case 'practice': this.actions.practice(); break
      case 'create': this.setBusy(true); this.actions.create(); break
      case 'joinScreen': this.els.joinError.textContent = ''; this.show('join'); break
      case 'locker': this.actions.openLocker(); this.show('locker'); break
      case 'menu': this.show('menu'); break
      case 'rename': (this.els.nameInput as HTMLInputElement).value = this.profile.name; this.show('name'); break
      case 'lockerRandom': this.setCosmetics(randomCosmetics()); break
      case 'lockerEmote': this.actions.lockerEmote(); break
      case 'start': this.actions.start(); break
      case 'leaveRoom': this.actions.leaveRoom(); break
      case 'resume': this.actions.resume(); break
      case 'quit': {
        // Leaving a live online match needs a second click so it cannot happen by accident.
        if (this.online && performance.now() > this.leaveArmed) {
          this.leaveArmed = performance.now() + 4000
          const b = this.els.quitBtn
          b.textContent = 'CLICK AGAIN TO LEAVE THE MATCH'
          window.setTimeout(() => { if (performance.now() > this.leaveArmed) b.textContent = 'LEAVE MATCH' }, 4100)
          break
        }
        this.leaveArmed = 0
        this.actions.quitToMenu()
        break
      }
      case 'copyLink': {
        const code = this.els.roomCode.textContent ?? ''
        const link = `${location.origin}${location.pathname}?room=${code}`
        void navigator.clipboard?.writeText(link).then(() => this.toast('Invite link copied'), () => this.toast(link))
        break
      }
      case 'copyCode': {
        const code = this.els.roomCode.textContent ?? ''
        void navigator.clipboard?.writeText(code).then(() => this.toast('Room code copied'), () => this.toast('Copy failed: select the code manually'))
        break
      }
      default: break
    }
  }

  /** Disable the connect buttons while a request is in flight. */
  setBusy(busy: boolean): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="create"], [data-el="joinBtn"]').forEach(b => { b.disabled = busy })
    if (busy) { this.els.menuError.textContent = ''; this.els.menuNote.textContent = 'Connecting to the game server…' }
    else this.els.menuNote.textContent = 'Online rooms hold up to 6 pilots in team deathmatch.'
  }

  // ---- locker ---------------------------------------------------------------------------------
  private buildLocker(): void {
    const tabs = this.els.lockerTabs
    for (const slot of SLOT_ORDER) {
      const b = el('button', 'tab', SLOT_LABELS[slot])
      b.type = 'button'
      b.dataset.slot = slot
      b.addEventListener('click', () => { this.lockerSlot = slot; this.renderLocker() })
      tabs.appendChild(b)
    }
    this.renderLocker()
  }

  private renderLocker(): void {
    this.els.lockerTabs.querySelectorAll<HTMLElement>('.tab').forEach(t => t.classList.toggle('on', t.dataset.slot === this.lockerSlot))
    const chips = this.els.lockerChips
    chips.replaceChildren()
    const slot = this.lockerSlot
    for (const opt of SLOT_OPTIONS[slot]) {
      const b = el('button', 'chip')
      b.type = 'button'
      const sw = el('i', 'swatch')
      if (opt.color) sw.style.background = opt.color
      else sw.classList.add('none')
      b.append(sw, document.createTextNode(opt.label))
      b.classList.toggle('on', this.profile.cosmetics[slot] === opt.id)
      b.addEventListener('click', () => {
        this.setCosmetics({ ...this.profile.cosmetics, [slot]: opt.id })
        if (slot === 'emote' && opt.id !== 'none') this.actions.lockerEmote()
      })
      chips.appendChild(b)
    }
  }

  private setCosmetics(c: Cosmetics): void {
    this.profile.cosmetics = c
    saveProfile(this.profile)
    this.actions.lockerChange(c)
    this.renderLocker()
  }

  // ---- screens --------------------------------------------------------------------------------
  /** The static boot screen lives in index.html so it paints before any script loads. */
  setBootProgress(progress: number, text = 'Loading…'): void {
    const fill = document.getElementById('boot-fill')
    const label = document.getElementById('boot-text')
    if (fill) fill.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`
    if (label) label.textContent = text
  }

  show(screen: Screen): void {
    this.screen = screen
    const boot = document.getElementById('boot')
    if (boot) boot.classList.toggle('done', screen !== 'boot')
    this.root.querySelectorAll<HTMLElement>('.screen').forEach(e => {
      const active = e.dataset.screen === screen
      e.hidden = !active
      e.classList.toggle('is-active', active)
    })
    document.body.dataset.screen = screen
    if (screen === 'menu') this.els.whoName.textContent = this.profile.name
    this.els.audioBox.hidden = !(['name', 'menu', 'join', 'lobby', 'pause', 'results'] as Screen[]).includes(screen)
    if (screen === 'name') window.setTimeout(() => (this.els.nameInput as HTMLInputElement).focus(), 50)
    if (screen === 'join' && this.inviteCode) (this.els.codeInput as HTMLInputElement).value = this.inviteCode
    if (screen === 'join') window.setTimeout(() => (this.els.codeInput as HTMLInputElement).focus(), 50)
    if (screen === 'locker') this.renderLocker()
    if (screen !== 'menu' && screen !== 'join') this.setBusy(false)
    if (screen !== 'hud') this.els.scoreboard.hidden = true
  }

  /** First screen after loading: ask for a callsign once, otherwise go to the menu. */
  enter(): void {
    if (this.profile.name) this.afterName()
    else { (this.els.nameInput as HTMLInputElement).value = ''; this.show('name') }
  }

  /** After the callsign is known: go to the menu, or straight to the join screen for an invite link. */
  private afterName(): void {
    if (this.inviteCode) {
      this.show('join')
      this.toast(`Invite link detected: press JOIN to enter room ${this.inviteCode}`)
    } else this.show('menu')
  }

  showMenuError(message: string): void {
    this.setBusy(false)
    if (this.screen === 'join') this.els.joinError.textContent = message
    else this.els.menuError.textContent = message
  }

  toast(message: string): void {
    const t = this.els.toast
    t.textContent = message
    t.hidden = false
    window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => { t.hidden = true }, 3500)
  }

  setConn(status: ConnStatus): void {
    const c = this.els.conn
    c.hidden = !(status === 'reconnecting')
    if (status === 'reconnecting') c.textContent = 'Connection lost. Reconnecting…'
  }

  // ---- lobby / results ------------------------------------------------------------------------
  private buildSettingsOptions(): void {
    const kl = this.els.killLimit as HTMLSelectElement
    const tl = this.els.timeLimit as HTMLSelectElement
    const [kMin, kMax] = matchData.limits.killLimit
    const [tMin, tMax] = matchData.limits.timeLimitMinutes
    for (let k = kMin; k <= kMax; k += k < 20 ? 5 : 10) kl.add(new Option(String(k), String(k)))
    for (let t = tMin; t <= tMax; t += t < 10 ? 1 : 5) tl.add(new Option(`${t} min`, String(t)))
  }

  updateLobby(room: RoomClient): void {
    const sig = JSON.stringify([room.code, room.hostId, room.roster, room.settings, room.myId])
    if (sig === this.lastLobby) return
    this.lastLobby = sig
    this.els.roomCode.textContent = room.code || '-----'
    const list = this.els.roster
    list.replaceChildren()
    for (const r of room.roster) {
      const li = el('li', `member ${TEAM_CLASS[r.team] ?? ''}`)
      li.append(el('span', 'dot'), el('span', 'nm', r.name))
      if (r.id === room.myId) li.append(el('small', 'tag', 'you'))
      if (r.host) li.append(el('small', 'tag host', 'host'))
      if (!r.connected) li.append(el('small', 'tag off', 'offline'))
      li.append(el('small', 'team', TEAM_NAMES[r.team] ?? ''))
      list.appendChild(li)
    }
    const host = room.isHost
    const kl = this.els.killLimit as HTMLSelectElement
    const tl = this.els.timeLimit as HTMLSelectElement
    kl.value = String(room.settings.killLimit)
    tl.value = String(room.settings.timeLimitMinutes)
    kl.disabled = tl.disabled = !host
    const start = this.els.startBtn as HTMLButtonElement
    start.hidden = !host
    this.els.lobbyNote.textContent = host
      ? `${room.roster.length}/${room.max} pilots. Share the code, then start when everyone is in.`
      : 'Waiting for the host to start the match…'
  }

  lobbyError(message: string): void {
    this.els.lobbyError.textContent = message
    window.setTimeout(() => { if (this.els.lobbyError.textContent === message) this.els.lobbyError.textContent = '' }, 4000)
  }

  showResults(info: ResultsInfo, myTeam: number): void {
    const win = info.winner
    this.els.resultTitle.textContent = win === -1 ? 'DRAW' : win === myTeam ? 'VICTORY' : 'DEFEAT'
    this.els.resultTitle.className = win === -1 ? '' : win === myTeam ? 'win' : 'lose'
    this.els.resultScore.textContent = `RED ${info.scores[0] ?? 0}  -  ${info.scores[1] ?? 0} BLUE`
    this.fillBoard(this.els.resultRows, info.rows.map(r => ({ id: r.id, name: r.name, team: r.team, kills: r.kills, deaths: r.deaths, me: false })))
    this.show('results')
  }

  private fillBoard(body: HTMLElement, rows: ScoreRow[]): void {
    body.replaceChildren()
    for (const r of rows) {
      const tr = el('tr', `${TEAM_CLASS[r.team] ?? ''}${r.me ? ' me' : ''}`)
      tr.append(el('td', '', r.name), el('td', '', TEAM_NAMES[r.team] ?? ''), el('td', '', String(r.kills)), el('td', '', String(r.deaths)))
      body.appendChild(tr)
    }
  }

  setPauseInfo(online: boolean): void {
    this.online = online
    this.leaveArmed = 0
    this.els.pauseNote.textContent = online ? 'The match keeps running while this menu is open.' : 'Practice is paused.'
    this.els.quitBtn.textContent = online ? 'LEAVE MATCH' : 'BACK TO MENU'
  }

  // ---- HUD ------------------------------------------------------------------------------------
  hit(kind: HitKind): void {
    const m = this.els.marker
    m.className = `marker ${kind}`
    void m.offsetWidth
    m.classList.add('on')
    window.clearTimeout(this.hitTimer)
    this.hitTimer = window.setTimeout(() => m.classList.remove('on'), kind === 'kill' ? 450 : 180)
  }

  damage(angle: number): void {
    const d = this.els.dmg
    d.style.setProperty('--a', Number.isNaN(angle) ? '0rad' : `${angle}rad`)
    d.classList.toggle('all', Number.isNaN(angle))
    d.classList.remove('on')
    void d.offsetWidth
    d.classList.add('on')
  }

  death(show: boolean, reason: string): void {
    this.els.respawn.hidden = !show
    if (show) this.els.deathTitle.textContent = reason.toUpperCase()
  }

  feed(e: FeedEntry): void {
    const row = el('div', `feed-row${e.mine ? ' mine' : ''}${e.me ? ' me' : ''}`)
    if (e.killer) row.append(el('b', TEAM_CLASS[e.killerTeam] ?? '', e.killer))
    row.append(el('span', 'wp', `${e.head ? '[HEAD] ' : ''}${e.killer ? '>' : ''} ${e.weapon}`), el('b', TEAM_CLASS[e.victimTeam] ?? '', e.victim))
    this.els.feed.appendChild(row)
    while (this.els.feed.children.length > 5) this.els.feed.firstElementChild?.remove()
    window.setTimeout(() => row.remove(), 6000)
  }

  banner(text: string, ms = 2000): void {
    const b = this.els.banner
    b.textContent = text
    b.classList.remove('on')
    void b.offsetWidth
    b.classList.add('on')
    window.clearTimeout(this.bannerTimer)
    this.bannerTimer = window.setTimeout(() => { b.classList.remove('on'); b.textContent = '' }, ms)
  }

  phase(phase: MatchPhase): void {
    if (phase === 'countdown') this.banner('GET READY', 3000)
    else if (phase === 'live') this.banner('GO!', 1200)
  }

  setLockHint(visible: boolean): void {
    this.els.lockHint.hidden = !visible
  }

  updateScoreboard(visible: boolean, rows: ScoreRow[]): void {
    this.els.scoreboard.hidden = !visible
    if (visible) this.fillBoard(this.els.scoreRows, rows)
  }

  updateHud(h: HudInfo): void {
    const hp = Math.ceil(h.health)
    if (hp !== this.last.health) {
      this.last.health = hp
      this.els.hpFill.style.transform = `scaleX(${h.health / h.maxHealth})`
      this.els.hpText.textContent = String(hp)
    }
    const fuel = Math.round(h.fuel)
    if (fuel !== this.last.fuel) {
      this.last.fuel = fuel
      this.els.fuelFill.style.transform = `scaleX(${h.fuel / h.maxFuel})`
      this.els.fuelText.textContent = String(fuel)
    }
    this.els.fuelBar.classList.toggle('low', h.fuel < 22)
    this.els.fuelBar.classList.toggle('empty', h.fuelLocked || h.fuel < 1)
    this.els.fuelBar.classList.toggle('burning', h.thrusting)
    if (h.weapon !== this.last.weapon) { this.last.weapon = h.weapon; this.els.weaponName.textContent = h.weapon }
    if (h.ammo !== this.last.ammo) { this.last.ammo = h.ammo; this.els.ammo.textContent = String(h.ammo) }
    if (h.clip !== this.last.clip) { this.last.clip = h.clip; this.els.clip.textContent = `/ ${h.clip}` }
    this.els.ammo.classList.toggle('low', h.ammo <= Math.ceil(h.clip * 0.25))
    this.els.reloadFill.style.transform = `scaleX(${h.reload})`
    this.els.reloadText.textContent = h.reload > 0 ? 'RELOADING' : h.ammo === 0 ? 'EMPTY · PRESS R' : ''
    this.els.reloadText.classList.toggle('on', h.reload > 0 || h.ammo === 0)
    this.els.crosshair.style.setProperty('--gap', `${(5 + h.spread * 6).toFixed(1)}px`)
    this.els.crosshair.classList.toggle('shielded', h.protect)
    if (h.dead) this.els.respawnTime.textContent = String(Math.ceil(h.respawn))
    this.els.pickupHint.textContent = h.pickupNear ? `Walk over to grab ${h.pickupNear}` : ''

    // Grenade row (rebuilt only when something changed).
    const gSig = JSON.stringify([h.grenades.map(g => g.count), h.grenadeSelected, Math.ceil(h.grenadeCooldown * 4)])
    if (gSig !== this.last.grenades) {
      this.last.grenades = gSig
      const box = this.els.grenades
      box.replaceChildren()
      h.grenades.forEach((g, i) => {
        const chip = el('div', `gchip${i === h.grenadeSelected ? ' on' : ''}${g.count === 0 ? ' empty' : ''}`)
        chip.style.setProperty('--c', g.color)
        chip.append(el('i'), el('span', 'gn', g.name), el('b', '', String(g.count)), el('kbd', '', String(i + 3)))
        box.appendChild(chip)
      })
    }

    // Match bar.
    const bar = this.els.matchBar
    bar.classList.toggle('practice', h.practice)
    if (h.practice) {
      this.els.clock.textContent = 'PRACTICE'
      this.els.matchSub.textContent = 'Shoot the targets · grab weapon crates'
    } else {
      const left = Math.max(0, Math.ceil(h.timeLeft))
      const m = Math.floor(left / 60)
      const s = String(left % 60).padStart(2, '0')
      const t = `${m}:${s}`
      if (t !== this.last.timer) { this.last.timer = t; this.els.clock.textContent = t }
      const sc = `${h.scores[0] ?? 0}-${h.scores[1] ?? 0}`
      if (sc !== this.last.scores) { this.last.scores = sc; this.els.scoreRed.textContent = String(h.scores[0] ?? 0); this.els.scoreBlue.textContent = String(h.scores[1] ?? 0) }
      this.els.matchSub.textContent = `${TEAM_NAMES[h.team] ?? ''} TEAM · FIRST TO ${h.killLimit}`
      this.els.net.textContent = `${h.ping} ms`
    }
    this.els.net.hidden = h.practice
  }
}


