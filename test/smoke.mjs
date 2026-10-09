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
import { File } from 'megajs'
import { parseMegaLink, tokenFromInput, decodeToken, isFolderDescriptor } from '../server/links.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = path.join(root, 'server', 'fixtures', 'demo-video.mp4')

let server = null
let cacheDir = null
let passed = 0
let failed = 0

// Unique per run: avoids colliding with stale servers from earlier runs.
const PORT = 18000 + Math.floor(Math.random() * 1900)
const BOOT_ID = `smoke-${process.pid}-${Date.now()}`
const BASE = `http://127.0.0.1:${PORT}`

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
    env: { ...process.env, DEMO_MODE: '1', PORT: String(PORT), CACHE_DIR: cacheDir, BOOT_ID },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  server.on('error', () => {})
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      const body = await res.json()
      // Only trust the instance we just spawned.
      if (res.ok && body.bootId === BOOT_ID) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Server did not start (or port was stolen by a stale instance)')
}

async function stopServer () {
  if (!server) return
  const child = server
  server = null
  const exited = new Promise((resolve) => child.on('exit', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
  await exited
  clearTimeout(timer)
}

// Never leave orphans behind, even on crash/Ctrl-C.
process.on('exit', () => {
  if (server) {
    try { server.kill('SIGKILL') } catch { /* already gone */ }
  }
})
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (server) {
      try { server.kill('SIGKILL') } catch { /* already gone */ }
    }
    process.exit(1)
  })
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

  // ---- URL contract between our link parser and the megajs SDK ----
  // (pure JS, no network: this is the exact seam real folder links cross)
  console.log('smoke: megajs URL contract')
  {
    const FOLDER_KEY = 'ZzYyXxWwVvTtRrQqPpOoNn' // 22-char folder key shape
    const FILE_KEY = 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVv' // 43-char file key shape

    const folderLink = parseMegaLink(`https://mega.nz/folder/AbCdEf123456#${FOLDER_KEY}`)
    const f1 = File.fromURL(folderLink.canonical)
    ok('folder URL parses as folder in megajs', f1.directory === true && f1.downloadId === 'AbCdEf123456' && !f1.loadedFile)
    ok('folder descriptors are folders', isFolderDescriptor(tokenFromInput(folderLink.canonical).descriptor))

    // The sub-file URLs minted by mega.js list() must parse back to loadedFile nodes
    const subUrl = `https://mega.nz/folder/${folderLink.downloadId}#${folderLink.key}/file/SubNode99`
    const subLink = parseMegaLink(subUrl)
    const f2 = File.fromURL(subLink.canonical)
    ok('mints valid file-in-folder URLs', subLink.kind === 'folder-file' && f2.directory === true && f2.loadedFile === 'SubNode99')
    ok('file-in-folder descriptors are files', !isFolderDescriptor(tokenFromInput(subUrl).descriptor))

    const fileLink = parseMegaLink(`https://mega.nz/file/AbCdEf123456#${FILE_KEY}`)
    const f3 = File.fromURL(fileLink.canonical)
    ok('file URL parses as file in megajs', f3.directory === false && f3.downloadId === 'AbCdEf123456')

    const legacy = parseMegaLink(`https://mega.nz/#F!AbCdEf123456!${FOLDER_KEY}`)
    const f4 = File.fromURL(legacy.canonical)
    ok('legacy folder links normalize cleanly', legacy.kind === 'folder' && f4.directory === true)

    const legacyFile = parseMegaLink(`https://mega.nz/#F!AbCdEf123456!${FOLDER_KEY}!SubNode99`)
    const f5 = File.fromURL(legacyFile.canonical)
    ok('legacy folder-file links normalize cleanly', legacyFile.kind === 'folder-file' && f5.loadedFile === 'SubNode99')
  }

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

    console.log('smoke: folder browsing')
    const folderRes = await fetch(`${BASE}/api/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demo: 'folder' })
    })
    const folder = await folderRes.json()
    ok('demo folder resolves', folderRes.ok && folder.type === 'folder' && folder.name === 'MegaDirect Demo Folder')
    ok('folder counts files', folder.counts.files === 6 && folder.counts.folders === 2)
    const nested = (folder.entries.find((e) => e.type === 'folder') || {}).children || []
    ok('nested folder tree', nested.some((e) => e.name === 'bonus-tone.wav') &&
      nested.some((e) => e.type === 'folder' && e.name === 'deep' && e.children.length === 1))
    ok('folder entries carry links', Boolean(folder.entries[0].links && folder.entries[0].links.download))

    const folderVideo = folder.entries.find((e) => e.type === 'file' && e.name.endsWith('.mp4'))
    const fv = await fetch(`${BASE}/api/info/${folderVideo.token}`)
    const fvInfo = await fv.json()
    ok('file picked from folder resolves', fvInfo.type === 'file' && fvInfo.name === 'MegaDirect-demo-plasma.mp4')
    const fvBytes = Buffer.from(await (await fetch(`${BASE}/s/${folderVideo.token}`, {
      headers: { Range: 'bytes=0-99' }
    })).arrayBuffer())
    ok('folder-picked file streams correctly', fvBytes.equals(fixture.subarray(0, 100)))

    const deepClip = nested.find((e) => e.type === 'folder' && e.name === 'deep').children[0]
    ok('deeply nested file has token', typeof deepClip.token === 'string' && deepClip.token.length > 8)

    const notFolder = await fetch(`${BASE}/api/folder/${folderVideo.token}`)
    ok('file token is not browsable', notFolder.status === 400)
    const folderStream = await fetch(`${BASE}/s/${folder.token}`)
    ok('folder token cannot be streamed', folderStream.status === 400)

    // Files inside folders expose their parent folder ("Browse folder" button)
    const inside = nested.find((e) => e.type === 'file' && e.name === 'inside-a-folder-clip.mp4')
    ok('folder listing exposes inside-folder file', Boolean(inside))
    const insideInfo = await (await fetch(`${BASE}/api/info/${inside.token}`)).json()
    ok('inside-folder file links back to its folder',
      Boolean(insideInfo.parent) && insideInfo.parent.token === folder.token)
    const parentRes = await fetch(`${BASE}/api/folder/${insideInfo.parent.token}`)
    ok('parent folder is browsable', parentRes.status === 200 && (await parentRes.json()).type === 'folder')

    console.log('smoke: error handling')
    const evil = await fetch(`${BASE}/api/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://evil.example.com/file/x#y' })
    })
    ok('rejects non-MEGA hosts', evil.status === 400)

    // Direct-mode browser fallback assets
    const linksLib = await fetch(`${BASE}/lib/links.js`)
    ok('serves shared link parser for direct mode', linksLib.status === 200 && (await linksLib.text()).includes('parseMegaLink'))
    const vendor = await fetch(`${BASE}/vendor/megajs.mjs`)
    ok('serves megajs browser bundle', vendor.status === 200 && (await vendor.text()).includes('export'))
    const directMod = await fetch(`${BASE}/direct.js`)
    ok('serves direct-mode module', directMod.status === 200 && (await directMod.text()).includes('directInfo'))
    const page = await fetch(`${BASE}/`)
    const csp = page.headers.get('content-security-policy') || ''
    ok('CSP allows direct MEGA access', csp.includes('*.mega.co.nz') && csp.includes('*.megapds.com'))

    // Regression: real-format folder links must reach the folder pipeline
    // (previously they were rejected before any MEGA call). Offline-safe:
    // the request may fail with a network/upstream error, but never with
    // "folder links are not supported".
    for (const [label, url, expectFolder] of [
      ['folder', 'https://mega.nz/folder/AbCdEf123456#ZzYyXxWwVvTt', true],
      ['legacy folder', 'https://mega.nz/#F!AbCdEf123456!ZzYyXxWwVvTt', true],
      ['file', 'https://mega.nz/file/AbCdEf123456#ZzYyXxWwVvTt', false]
    ]) {
      const res = await fetch(`${BASE}/api/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      })
      const body = await res.json()
      const rejected =
        body.code === 'FOLDER' || body.code === 'BAD_LINK' || /not supported/i.test(body.error || '')
      if (res.ok) {
        ok(`real ${label} link resolves`, expectFolder ? body.type === 'folder' : body.type === 'file')
      } else {
        ok(`real ${label} link reaches MEGA pipeline`, !rejected && res.status >= 500,
          rejected ? `blocked early: ${body.code} ${body.error}` : `upstream: ${body.code || res.status}`)
      }
    }

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
