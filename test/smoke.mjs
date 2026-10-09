/**
 * Smoke test: boots the server in demo mode against a throwaway cache dir
 * and verifies info, byte-range streaming, full-file integrity, cache
 * persistence across restart, and error handling.
 *
 * Usage: npm test
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 18777
const BASE = `http://127.0.0.1:${PORT}`
const FIXTURE = path.join(root, 'server', 'fixtures', 'demo-video.mp4')

let server = null
let cacheDir = null
let passed = 0
let failed = 0

function ok (name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

async function startServer () {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, DEMO_MODE: '1', PORT: String(PORT), CACHE_DIR: cacheDir },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Server did not start')
}

async function stopServer () {
  if (!server) return
  server.kill('SIGTERM')
  await new Promise((r) => server.on('exit', r))
  server = null
}

function patternBytes (absStart, length) {
  const out = Buffer.alloc(length)
  const tail = Buffer.alloc(4)
  for (let i = 0; i < length; i += 4) {
    let x = ((((absStart + i) >>> 2) + 0x9e3779b9) >>> 0)
    x = (x ^ ((x << 13) >>> 0)) >>> 0
    x = (x ^ (x >>> 17)) >>> 0
    x = (x ^ ((x << 5) >>> 0)) >>> 0
    if (i + 4 <= length) {
      out.writeUInt32LE(x, i)
    } else {
      tail.writeUInt32LE(x, 0)
      tail.copy(out, i, 0, length - i)
    }
  }
  return out
}

async function run () {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'megadirect-test-'))
  console.log('smoke: starting server…')
  await startServer()

  try {
    console.log('smoke: info')
    const infoRes = await fetch(`${BASE}/api/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demo: 'video' })
    })
    const info = await infoRes.json()
    ok('info resolves demo video', infoRes.ok && info.name === 'MegaDirect-demo-plasma.mp4')
    ok('info reports playable video', info.playable === true && info.kind === 'video')
    ok('info size matches fixture', info.size === (await readFile(FIXTURE)).length)

    console.log('smoke: ranges')
    const head = await fetch(`${BASE}/s/${info.token}`, { headers: { Range: 'bytes=0-99' } })
    const headBytes = Buffer.from(await head.arrayBuffer())
    const fixture = await readFile(FIXTURE)
    ok('range 0-99 is 206', head.status === 206)
    ok('range 0-99 content matches', headBytes.equals(fixture.subarray(0, 100)))
    ok('content-range header', head.headers.get('content-range') === `bytes 0-99/${info.size}`)

    const mid = await fetch(`${BASE}/s/${info.token}`, { headers: { Range: 'bytes=123456-123555' } })
    const midBytes = Buffer.from(await mid.arrayBuffer())
    ok('mid-file range matches', midBytes.equals(fixture.subarray(123456, 123556)))

    const suffix = await fetch(`${BASE}/s/${info.token}`, { headers: { Range: 'bytes=-256' } })
    const suffixBytes = Buffer.from(await suffix.arrayBuffer())
    ok('suffix range matches', suffixBytes.equals(fixture.subarray(fixture.length - 256)))

    const single = await fetch(`${BASE}/s/${info.token}`, { headers: { Range: 'bytes=0-0' } })
    ok('single-byte range works', single.status === 206 && Buffer.from(await single.arrayBuffer()).length === 1)

    const bad = await fetch(`${BASE}/s/${info.token}`, { headers: { Range: 'bytes=999999999-' } })
    ok('unsatisfiable range is 416', bad.status === 416)

    console.log('smoke: full download')
    const full = await fetch(`${BASE}/d/${info.token}`)
    const fullBytes = Buffer.from(await full.arrayBuffer())
    const sha = (buf) => createHash('sha256').update(buf).digest('hex')
    ok('download equals fixture', sha(fullBytes) === sha(fixture))
    ok('download is attachment', (full.headers.get('content-disposition') || '').startsWith('attachment'))

    console.log('smoke: demo pattern file')
    const fileRes = await fetch(`${BASE}/api/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demo: 'file' })
    })
    const fileInfo = await fileRes.json()
    ok('demo file resolves', fileInfo.size === 24 * 1024 * 1024)
    const seg = await fetch(`${BASE}/s/${fileInfo.token}`, { headers: { Range: 'bytes=5000000-5000199' } })
    const segBytes = Buffer.from(await seg.arrayBuffer())
    ok('demo pattern range matches generator', segBytes.equals(patternBytes(5000000, 200)))

    console.log('smoke: error handling')
    const evil = await fetch(`${BASE}/api/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://evil.example.com/file/x#y' })
    })
    ok('rejects non-MEGA hosts', evil.status === 400)

    const folder = await fetch(`${BASE}/api/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://mega.nz/folder/AbCdEf123#SomeKey' })
    })
    ok('rejects plain folder links', folder.status === 400)

    console.log('smoke: cache persistence across restart')
    await stopServer()
    await startServer()
    const after = await fetch(`${BASE}/s/${info.token}`, { headers: { Range: 'bytes=200000-200099' } })
    const afterBytes = Buffer.from(await after.arrayBuffer())
    ok('serves from cache after restart', after.status === 206 && afterBytes.equals(fixture.subarray(200000, 200100)))
    ok('x-cache hit after restart', after.headers.get('x-cache') === 'hit')
    const state = await (await fetch(`${BASE}/api/state/${info.token}`)).json()
    ok('state reports complete cache', state.complete === true && state.cachedBytes === info.size)
  } finally {
    await stopServer()
    await rm(cacheDir, { recursive: true, force: true })
  }

  console.log(`\nsmoke: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
