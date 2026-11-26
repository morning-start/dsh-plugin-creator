/**
 * Browser-driven UI checks over Chrome DevTools Protocol.
 *
 * A sandbox gives you a URL and a token; this module gives you eyes. It launches
 * (or reuses) a headless Chrome with remote debugging, opens the page, and then
 * answers three kinds of question:
 *
 * - **what does it look like** — `Page.captureScreenshot`, written to a file;
 * - **is it correct** — `Runtime.evaluate` assertions (selector present, text
 *   matches, slot registered), plus the console and network failures the page
 *   produced while loading;
 * - **does it work when clicked** — real input events at the element's centre,
 *   not a synthetic `element.click()`, because contenteditable and React inputs
 *   ignore the synthetic path.
 *
 * Two rules, both learned the hard way on a plugin UI project:
 *
 * - **never claim a screenshot you did not take** — a failed capture is an error,
 *   not a placeholder;
 * - **a screenshot is evidence of rendering, not of correctness** — assertions
 *   say what must be true, the image says what the user would see.
 *
 * Node built-ins only: `WebSocket` is global from Node 22, and a preset row
 * cannot import anything from the profile.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_PORT = 9222
const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
}

/** The browser binary to drive: `CHROME_PATH`, else the first one that exists. */
export function findChrome({ env = process.env, platform = process.platform } = {}) {
  if (typeof env.CHROME_PATH === 'string' && env.CHROME_PATH.length > 0) return env.CHROME_PATH
  for (const candidate of CANDIDATES[platform] ?? CANDIDATES.linux) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function sleep(ms) {
  return new Promise(done => setTimeout(done, ms))
}

async function probe(url, timeoutMs = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.status
  } catch {
    return 0
  }
}

/**
 * Start headless Chrome with remote debugging, or reuse a live one.
 * @returns {Promise<{port: number, started: boolean, browser?: string}>}
 */
export async function ensureChrome(options = {}) {
  const port = options.port ?? DEFAULT_PORT
  if ((await probe(`http://127.0.0.1:${port}/json/version`)) > 0) return { port, started: false }

  const browser = options.browser ?? findChrome()
  if (browser === undefined) {
    throw new Error('no Chrome or Edge found; set CHROME_PATH, or start one with --remote-debugging-port')
  }
  const profile = options.profileDir ?? mkdtempSync(join(tmpdir(), 'dsh-ui-'))
  const size = options.windowSize ?? '1440x900'
  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${size}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250)
    if ((await probe(`http://127.0.0.1:${port}/json/version`)) > 0) return { port, started: true, browser, profile }
  }
  throw new Error(`headless browser did not expose CDP on ${port} within 10s`)
}

/** Minimal CDP client: one page target, request/response, and a log buffer. */
export class Page {
  constructor(socket, target) {
    this.socket = socket
    this.target = target
    this.nextId = 1
    this.pending = new Map()
    this.waiters = []
    this.logs = []
    socket.addEventListener('message', event => this.receive(JSON.parse(event.data)))
  }

  receive(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) reject(new Error(`${message.error.message} ${message.error.data ?? ''}`))
      else resolve(message.result)
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = message.params.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' ')
      this.logs.push({ kind: 'console', type: message.params.type, text: clip(text) })
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      this.logs.push({ kind: 'exception', text: clip(details.text), detail: clip(details.exception?.description) })
    } else if (message.method === 'Log.entryAdded') {
      const entry = message.params.entry
      this.logs.push({ kind: 'log', level: entry.level, text: clip(entry.text), url: entry.url })
    } else if (message.method === 'Network.loadingFailed') {
      this.logs.push({ kind: 'netfail', text: `${message.params.type} ${message.params.errorText}` })
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.method !== message.method) continue
      waiter.resolve(message.params)
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
    }
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  once(method, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve }
      this.waiters.push(waiter)
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`timed out waiting for ${method}`))
      }, timeoutMs)
      timer.unref?.()
    })
  }

  async enable(options = {}) {
    await this.send('Runtime.enable')
    await this.send('Log.enable')
    await this.send('Page.enable')
    await this.send('Network.enable')
    await this.send('Network.setCacheDisabled', { cacheDisabled: true })
    if (options.width !== undefined) {
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: options.width,
        height: options.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
    }
  }

  async navigate(url, settleMs = 1200) {
    const loaded = this.once('Page.loadEventFired', 25_000).catch(() => null)
    await this.send('Page.navigate', { url })
    await loaded
    await sleep(settleMs)
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }

  async screenshot(path) {
    const capture = await this.send('Page.captureScreenshot', { format: 'png' })
    if (typeof capture.data !== 'string' || capture.data.length === 0) {
      throw new Error('Page.captureScreenshot returned no data')
    }
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, Buffer.from(capture.data, 'base64'))
    return path
  }

  /** Element centre in CSS pixels, or undefined when it is not there. */
  async centre(selector) {
    return await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height }
    })()`)
  }

  /** Real mouse press and release: synthetic clicks are ignored by many inputs. */
  async click(selector) {
    const point = await this.centre(selector)
    if (point === null) throw new Error(`click: ${selector} is not in the page`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type,
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      })
    }
    await sleep(150)
    return point
  }

  /** Focus the element, then insert text the way a keyboard would. */
  async type(selector, text) {
    const focused = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.focus()
      return document.activeElement === el || el.isContentEditable
    })()`)
    if (!focused) throw new Error(`type: could not focus ${selector}`)
    await this.send('Input.insertText', { text })
    await sleep(150)
  }

  /**
   * Release the target and the socket.
   *
   * The close handshake is awaited with a timeout: a page that has already gone
   * away never answers, and a caller must not hang on a browser that is still
   * alive for the next check.
   */
  async close() {
    try {
      await this.send('Page.close')
    } catch {
      // The target may already be gone.
    }
    await new Promise((resolve) => {
      const done = () => resolve()
      this.socket.addEventListener('close', done, { once: true })
      try {
        this.socket.close()
      } catch {
        resolve()
      }
      const timer = setTimeout(resolve, 1000)
      timer.unref?.()
    })
  }
}

/** Open a page target for `url` and return it ready to drive. */
export async function openPage(url, options = {}) {
  const { port } = await ensureChrome(options)
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = list.find(entry => entry.type === 'page')
  const endpoint = target === undefined
    ? await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json()
    : target

  const socket = new WebSocket(endpoint.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error(`cannot open CDP socket for ${endpoint.webSocketDebuggerUrl}`)), { once: true })
  })

  const page = new Page(socket, endpoint)
  const [width, height] = (options.size ?? '1440x900').split('x').map(Number)
  await page.enable({ width, height })
  if (url !== undefined) await page.navigate(url, options.settleMs)
  return page
}

/**
 * Run assertions against an open page.
 *
 * Each assertion is data, so a caller can describe a check without writing a
 * script: `{ selector }`, `{ text }`, `{ expression }`, or `{ noConsoleErrors }`.
 */
export async function runAssertions(page, assertions = []) {
  const checks = []
  for (const assertion of assertions) {
    const id = assertion.id ?? describe(assertion)
    try {
      const { passed, detail } = await evaluateAssertion(page, assertion)
      checks.push({ id, status: passed ? 'pass' : 'fail', detail })
    } catch (error) {
      checks.push({ id, status: 'fail', detail: error.message })
    }
  }
  const summary = { pass: 0, fail: 0 }
  for (const check of checks) summary[check.status] += 1
  return { ok: summary.fail === 0, summary, checks }
}

async function evaluateAssertion(page, assertion) {
  if (assertion.selector !== undefined) {
    const found = await page.evaluate(`document.querySelector(${JSON.stringify(assertion.selector)}) !== null`)
    return { passed: found, detail: `${assertion.selector} ${found ? 'is present' : 'is missing'}` }
  }
  if (assertion.text !== undefined) {
    const body = await page.evaluate('document.body.innerText')
    const found = String(body).includes(assertion.text)
    return { passed: found, detail: `text ${JSON.stringify(assertion.text)} ${found ? 'found' : 'not found'}` }
  }
  if (assertion.expression !== undefined) {
    const value = await page.evaluate(assertion.expression)
    const passed = assertion.equals === undefined ? Boolean(value) : JSON.stringify(value) === JSON.stringify(assertion.equals)
    return { passed, detail: `${assertion.expression} → ${clip(JSON.stringify(value))}` }
  }
  if (assertion.noConsoleErrors === true) {
    const errors = page.logs.filter(entry => entry.kind === 'exception'
      || (entry.kind === 'console' && entry.type === 'error')
      || (entry.kind === 'log' && entry.level === 'error'))
    return { passed: errors.length === 0, detail: errors.length === 0 ? 'no console errors' : `${errors.length} console error(s): ${errors.slice(0, 3).map(entry => clip(entry.text, 120)).join(' | ')}` }
  }
  if (assertion.noNetworkFailures === true) {
    const failures = page.logs.filter(entry => entry.kind === 'netfail')
    return { passed: failures.length === 0, detail: failures.length === 0 ? 'no failed requests' : failures.slice(0, 3).map(entry => entry.text).join(' | ') }
  }
  throw new Error(`unknown assertion: ${JSON.stringify(assertion)}`)
}

function describe(assertion) {
  if (assertion.selector !== undefined) return `selector ${assertion.selector}`
  if (assertion.text !== undefined) return `text ${JSON.stringify(assertion.text)}`
  if (assertion.expression !== undefined) return `expression ${clip(assertion.expression, 60)}`
  if (assertion.noConsoleErrors === true) return 'no console errors'
  if (assertion.noNetworkFailures === true) return 'no network failures'
  return 'assertion'
}

function clip(value, limit = 400) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Kill the browser this module started, if any (a reused one is left alone). */
export function stopChrome(port = DEFAULT_PORT) {
  if (process.platform === 'win32') {
    const output = spawnSync('netstat -ano', { encoding: 'utf8', shell: true }).stdout ?? ''
    const pids = new Set()
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes(`:${port} `) || !line.includes('LISTENING')) continue
      const columns = line.trim().split(/\s+/)
      const pid = columns[columns.length - 1]
      if (/^\d+$/.test(pid)) pids.add(pid)
    }
    for (const pid of pids) spawnSync(`taskkill /PID ${pid} /F`, { shell: true, encoding: 'utf8' })
    return [...pids]
  }
  const output = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).stdout ?? ''
  const pids = output.split(/\s+/).filter(value => /^\d+$/.test(value))
  for (const pid of pids) spawnSync('kill', ['-9', pid], { encoding: 'utf8' })
  return pids
}
