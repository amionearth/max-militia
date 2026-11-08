// Runs the multiplayer server (:8787) and the Vite dev server (:3000) together.
// Usage: pnpm dev:all   (PORT / WS_PORT env vars override the defaults)
import { spawn } from 'node:child_process'

const webPort = process.env.PORT ?? '3000'
const wsPort = process.env.WS_PORT ?? '8787'
const node = process.execPath
const children = [
  spawn(node, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], { stdio: 'inherit', env: { ...process.env, PORT: wsPort } }),
  spawn(node, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', webPort, '--strictPort'], { stdio: 'inherit', env: { ...process.env, PORT: webPort } }),
]
const stop = () => { for (const c of children) { try { c.kill() } catch { /* already gone */ } } }
process.on('SIGINT', () => { stop(); process.exit(0) })
process.on('exit', stop)
for (const c of children) c.on('exit', code => { if (code) { stop(); process.exit(code) } })
console.log(`\nMAX MILITIA: game http://127.0.0.1:${webPort}  |  multiplayer server ws://127.0.0.1:${wsPort}\n`)
