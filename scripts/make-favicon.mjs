import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'

const svg = readFileSync('public/favicon.svg', 'utf8')
mkdirSync('assets/share', { recursive: true })
const browser = await chromium.launch({ channel: 'msedge' })
const page = await (await browser.newContext({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 })).newPage()
await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:256px;height:256px">${svg.replace('<svg ', '<svg width="256" height="256" ')}</div></body></html>`)
await page.screenshot({ path: 'assets/share/favicon.png', omitBackground: true, clip: { x: 0, y: 0, width: 256, height: 256 } })
await browser.close()
console.log('favicon written')
