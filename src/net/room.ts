/**
 * Room client: owns the WebSocket, the lobby state, ping measurement and automatic reconnect with
 * the resume token. The UI listens to its callbacks; the game session reads snapshots from it.
 */
import type { Snapshot } from '../shared/match'
import type { Cosmetics } from '../shared/cosmetics'
import type { ClientMessage, ErrorCode, ResultRow, RoomSettings, RosterEntry, ServerMessage } from '../shared/protocol'
import { DEFAULT_SETTINGS } from '../shared/protocol'

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
export type ResultsInfo = { scores: number[]; winner: number; rows: ResultRow[] }

/** Resolve the multiplayer server URL: build-time env, then `?server=` (ws/wss only), then same host :8787. */
export function serverUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_WS_URL
  if (env) return env
  try {
    const q = new URLSearchParams(location.search).get('server')
    if (q && /^wss?:\/\//i.test(q)) return q
  } catch { /* ignore */ }
  const secure = location.protocol === 'https:'
  return `${secure ? 'wss' : 'ws'}://${location.hostname || 'localhost'}:8787`
}

export class RoomClient {
  status: ConnStatus = 'idle'
  code = ''
  myId = ''
  hostId = ''
  roster: RosterEntry[] = []
  settings: RoomSettings = { ...DEFAULT_SETTINGS }
  state: 'lobby' | 'match' | 'results' = 'lobby'
  max = 6
  rtt = 0
  results: ResultsInfo | null = null

  onLobby: () => void = () => undefined
  onSnapshot: (s: Snapshot) => void = () => undefined
  onResults: (r: ResultsInfo) => void = () => undefined
  onError: (code: ErrorCode | 'network', message: string) => void = () => undefined
  onStatus: (s: ConnStatus) => void = () => undefined
  /** Fired when the server removed us (left / timeout) or the connection could not be restored. */
  onLeft: (reason: string) => void = () => undefined

  private ws: WebSocket | null = null
  private token = ''
  private pingTimer = 0
  private reconnectTimer = 0
  private attempts = 0
  private intentionalClose = false
  private pendingFirst: ClientMessage | null = null
  private everJoined = false

  get inRoom(): boolean {
    return this.code !== ''
  }
  get isHost(): boolean {
    return this.myId !== '' && this.myId === this.hostId
  }

  create(name: string, cosmetics: Cosmetics): Promise<void> {
    return this.open({ t: 'create', name, cosmetics })
  }
  join(code: string, name: string, cosmetics: Cosmetics): Promise<void> {
    return this.open({ t: 'join', code, name, cosmetics })
  }

  private open(first: ClientMessage): Promise<void> {
    this.teardown()
    this.intentionalClose = false
    this.everJoined = false
    this.pendingFirst = first
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (message: string) => { if (!settled) { settled = true; this.teardown(); this.setStatus('closed'); reject(new Error(message)) } }
      const prevError = this.onError
      const prevLobby = this.onLobby
      const restore = () => { this.onError = prevError; this.onLobby = prevLobby }
      this.onError = (code, message) => { if (!settled) { settled = true; restore(); this.teardown(); reject(new Error(message)) } else prevError(code, message) }
      this.onLobby = () => { if (!settled) { settled = true; restore(); resolve() } prevLobby() }
      this.setStatus('connecting')
      try {
        this.connectSocket(() => { restore(); fail('Could not reach the game server. Is it running?') })
      } catch {
        restore()
        fail('Could not reach the game server.')
      }
      window.setTimeout(() => { if (!settled) { restore(); fail('The game server did not answer in time.') } }, 8000)
    })
  }

  private connectSocket(onFail: () => void): void {
    const ws = new WebSocket(serverUrl())
    this.ws = ws
    let opened = false
    ws.onopen = () => {
      opened = true
      this.setStatus('open')
      this.attempts = 0
      if (this.pendingFirst) { this.send(this.pendingFirst); this.pendingFirst = null }
      window.clearInterval(this.pingTimer)
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000)
    }
    ws.onmessage = ev => {
      if (typeof ev.data !== 'string') return
      let msg: ServerMessage
      try { msg = JSON.parse(ev.data) as ServerMessage } catch { return }
      this.handle(msg)
    }
    ws.onerror = () => { /* onclose follows */ }
    ws.onclose = () => {
      window.clearInterval(this.pingTimer)
      if (this.ws !== ws) return
      if (this.intentionalClose) return
      if (!opened) { onFail(); return }
      if (this.inRoom && this.token) this.scheduleReconnect()
      else this.setStatus('closed')
    }
  }

  private scheduleReconnect(): void {
    if (this.attempts >= 6) {
      this.setStatus('closed')
      this.clearRoom()
      this.onLeft('Connection lost')
      return
    }
    this.setStatus('reconnecting')
    const delay = Math.min(4000, 600 * 2 ** this.attempts)
    this.attempts++
    window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = window.setTimeout(() => {
      this.pendingFirst = { t: 'resume', code: this.code, token: this.token }
      try { this.connectSocket(() => this.scheduleReconnect()) } catch { this.scheduleReconnect() }
    }, delay)
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.myId = msg.id
        this.code = msg.code
        this.token = msg.token
        this.everJoined = true
        break
      case 'lobby':
        this.code = msg.code
        this.hostId = msg.hostId
        this.roster = msg.roster
        this.settings = msg.settings
        this.state = msg.state
        this.max = msg.max
        this.onLobby()
        break
      case 'snap': this.onSnapshot(msg.s); break
      case 'results':
        this.results = { scores: msg.scores, winner: msg.winner, rows: msg.rows }
        this.onResults(this.results)
        break
      case 'pong': this.rtt = this.rtt === 0 ? performance.now() - msg.c : this.rtt * 0.7 + (performance.now() - msg.c) * 0.3; break
      case 'error':
        if (msg.code === 'bad_token' && this.everJoined) {
          this.clearRoom()
          this.teardown()
          this.onLeft('Your session expired')
        } else this.onError(msg.code, msg.message)
        break
      case 'left':
        this.intentionalClose = true
        this.clearRoom()
        this.onLeft(msg.reason === 'timeout' ? 'You were disconnected for too long' : 'You left the room')
        break
      default: break
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }
  sendCosmetics(cosmetics: Cosmetics): void {
    this.send({ t: 'cosmetics', cosmetics })
  }
  updateSettings(settings: RoomSettings): void {
    this.send({ t: 'settings', settings })
  }
  start(): void {
    this.send({ t: 'start' })
  }

  leave(): void {
    this.send({ t: 'leave' })
    this.intentionalClose = true
    this.clearRoom()
    window.setTimeout(() => this.teardown(), 150)
  }

  private clearRoom(): void {
    this.code = ''; this.myId = ''; this.hostId = ''; this.roster = []; this.token = ''; this.state = 'lobby'; this.results = null
  }

  private setStatus(s: ConnStatus): void {
    if (this.status === s) return
    this.status = s
    this.onStatus(s)
  }

  teardown(): void {
    window.clearInterval(this.pingTimer)
    window.clearTimeout(this.reconnectTimer)
    const ws = this.ws
    this.ws = null
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.onerror = null; try { ws.close() } catch { /* already closed */ } }
    this.setStatus('idle')
  }
}
