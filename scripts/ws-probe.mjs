import WebSocket from 'ws'
const ws = new WebSocket('ws://127.0.0.1:8787')
ws.on('message', d => { const m = JSON.parse(d.toString()); console.log(m.t, m.code ?? '', m.roster?.length ?? ''); if (m.t === 'welcome') { ws.send(JSON.stringify({t:'start'})) } if (m.t==='snap') { console.log('snap ph', m.s.ph, 'players', m.s.p.length, 'pk', m.s.pk.length); ws.close(); process.exit(0) } })
ws.on('open', () => ws.send(JSON.stringify({ t: 'create', name: 'Probe', cosmetics: {} })))
setTimeout(() => { console.log('timeout'); process.exit(1) }, 6000)
