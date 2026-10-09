import express from 'express'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'
import { CacheStore, FillError } from './cache.js'
import { tokenFromInput, decodeToken, isFolderDescriptor, parseMegaLink, encodeToken, LinkError } from './links.js'
import { mediaInfo, contentDisposition } from './mime.js'
import { parseRange } from './ranges.js'
import { createMegaSource } from './sources/mega.js'
import { createDemoSource } from './sources/demo.js'

function sourceFactory (descriptor) {
  if (descriptor.demo) {
    if (!config.demoMode) {
      throw new FillError('Demo mode is disabled on this server.', { code: 'NO_DEMO', status: 404 })
    }
    return createDemoSource(descriptor)
  }
  return createMegaSource(descriptor)
}

const store = new CacheStore({
  dir: config.cacheDir,
  maxBytes: config.cacheMaxBytes,
  prefetch: config.prefetch,
  prefetchMaxBytes: config.prefetchMaxBytes,
  segmentBytes: config.segmentBytes,
  sourceFactory
})

const app = express()
if (config.trustProxy) app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(express.json({ limit: '8kb' }))

// ---------------------------------------------------------------- security
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  next()
})

// ---------------------------------------------------------------- rate limit
function rateLimit ({ windowMs, max }) {
  const hits = new Map()
  return (req, res, next) => {
    const key = req.ip || 'anon'
    const now = Date.now()
    let rec = hits.get(key)
    if (!rec || now > rec.reset) {
      rec = { n: 0, reset: now + windowMs }
      hits.set(key, rec)
    }
    rec.n++
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now > v.reset) hits.delete(k)
    }
    if (rec.n > max) {
      res.status(429).json({ error: 'Too many requests — please slow down a little.', code: 'RATE_LIMIT' })
      return
    }
    next()
  }
}

const apiLimiter = rateLimit({ windowMs: 60_000, max: 300 })
const resolveLimiter = rateLimit({ windowMs: 60_000, max: 30 })

// ---------------------------------------------------------------- helpers
async function entryForToken (token) {
  const descriptor = decodeToken(token)
  return store.getEntry(descriptor, async (source) => {
    const info = await source.resolve()
    return { name: info.name, size: info.size, mime: mediaInfo(info.name).mime }
  })
}

function describeEntry (entry, token) {
  const media = mediaInfo(entry.name)
  return {
    type: 'file',
    token,
    name: entry.name,
    size: entry.size,
    mime: entry.mime,
    kind: media.kind,
    playable: media.playable,
    demo: Boolean(entry.descriptor && entry.descriptor.demo),
    links: {
      watch: `/v/${token}`,
      stream: `/s/${token}`,
      download: `/d/${token}`
    }
  }
}

function enrichEntries (entries) {
  return entries.map((e) => {
    if (e.type === 'folder') {
      return { type: 'folder', name: e.name, children: enrichEntries(e.children || []) }
    }
    const media = mediaInfo(e.name)
    return {
      type: 'file',
      name: e.name,
      size: typeof e.size === 'number' ? e.size : 0,
      modified: typeof e.modified === 'number' ? e.modified : null,
      kind: media.kind,
      playable: media.playable,
      token: e.token,
      links: {
        watch: `/v/${e.token}`,
        stream: `/s/${e.token}`,
        download: `/d/${e.token}`
      }
    }
  })
}

function countEntries (entries) {
  const counts = { files: 0, folders: 0, bytes: 0 }
  for (const e of entries) {
    if (e.type === 'folder') {
      counts.folders++
      const sub = countEntries(e.children || [])
      counts.files += sub.files
      counts.folders += sub.folders
      counts.bytes += sub.bytes
    } else {
      counts.files++
      counts.bytes += e.size || 0
    }
  }
  return counts
}

// Folder listings are cached briefly: browsing clicks should not re-hit MEGA.
const folderListings = new Map()
const FOLDER_LISTING_TTL = 60_000

async function folderInfo (descriptor, token) {
  const key = JSON.stringify(descriptor)
  const hit = folderListings.get(key)
  if (hit && hit.expires > Date.now()) {
    return { ...hit.data, token }
  }
  const source = sourceFactory(descriptor)
  const listing = await source.list()
  const entries = enrichEntries(listing.entries)
  const data = {
    type: 'folder',
    name: listing.name,
    entries,
    counts: countEntries(entries),
    truncated: Boolean(listing.truncated),
    demo: Boolean(descriptor.demo)
  }
  if (folderListings.size > 200) folderListings.clear()
  folderListings.set(key, { expires: Date.now() + FOLDER_LISTING_TTL, data })
  return { ...data, token }
}

async function infoForToken (token) {
  const descriptor = decodeToken(token)
  if (isFolderDescriptor(descriptor)) {
    return folderInfo(descriptor, token)
  }
  const entry = await store.getEntry(descriptor, async (source) => {
    const info = await source.resolve()
    return { name: info.name, size: info.size, mime: mediaInfo(info.name).mime }
  })
  const info = describeEntry(entry, token)
  // Files that live inside a shared folder: offer browsing the parent folder.
  if (descriptor.demo === 'folder-file') {
    const parentToken = encodeToken({ demo: 'folder' })
    info.parent = {
      token: parentToken,
      links: { browse: `/v/${parentToken}`, folder: `/api/folder/${parentToken}` }
    }
  } else if (descriptor.u) {
    const link = parseMegaLink(descriptor.u)
    if (link.kind === 'folder-file') {
      const parentToken = encodeToken({ u: `https://mega.nz/folder/${link.downloadId}#${link.key}` })
      info.parent = {
        token: parentToken,
        links: { browse: `/v/${parentToken}`, folder: `/api/folder/${parentToken}` }
      }
    }
  }
  return info
}

function serveEntry (req, res, entry, { attachment }) {
  const size = entry.size
  const media = mediaInfo(entry.name)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', entry.mime || media.mime)
  res.setHeader('Content-Disposition', contentDisposition(entry.name, attachment ? 'attachment' : 'inline'))
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
  res.setHeader('X-Cache', entry.complete ? 'hit' : 'partial')

  const range = parseRange(req.headers.range, size)
  if (range.type === 'unsatisfiable') {
    res.status(416)
    res.setHeader('Content-Range', `bytes */${size}`)
    res.end()
    return
  }

  let start = 0
  let end = size - 1
  if (range.type === 'range') {
    start = range.start
    end = range.end
    res.status(206)
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  } else {
    res.status(200)
  }
  res.setHeader('Content-Length', String(Math.max(0, end - start + 1)))

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  entry.requestFill(start, end)
  const stream = entry.createReadStream(start, end)
  stream.on('error', (err) => {
    if (!res.headersSent) {
      const status = err.status || 502
      res.status(status)
      if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter))
      res.json({
        error: err.message || 'Upstream error',
        code: err.code || 'UPSTREAM',
        retryAfter: err.retryAfter || null
      })
    } else {
      res.destroy(err)
    }
  })
  res.on('close', () => {
    if (!stream.destroyed) stream.destroy()
  })
  stream.pipe(res)
}

function wrap (fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

const bootId = process.env.BOOT_ID || crypto.randomUUID()

// ---------------------------------------------------------------- API
app.get('/api/health', (req, res) => {
  res.json({ ok: true, demoMode: config.demoMode, bootId })
})

app.get('/api/stats', apiLimiter, (req, res) => {
  res.json({ cache: store.stats(), demoMode: config.demoMode })
})

app.post('/api/info', resolveLimiter, wrap(async (req, res) => {
  const body = req.body || {}
  let input = body.url
  if (!input && body.demo) input = `demo:${body.demo}`
  const { token } = tokenFromInput(input)
  res.json(await infoForToken(token))
}))

app.get('/api/info/:token', resolveLimiter, wrap(async (req, res) => {
  res.json(await infoForToken(req.params.token))
}))

app.get('/api/folder/:token', resolveLimiter, wrap(async (req, res) => {
  const descriptor = decodeToken(req.params.token)
  if (!isFolderDescriptor(descriptor)) {
    throw new FillError('This link is a single file, not a folder.', { code: 'NOT_FOLDER', status: 400 })
  }
  res.json(await folderInfo(descriptor, req.params.token))
}))

app.get('/api/state/:token', apiLimiter, wrap(async (req, res) => {
  const entry = await entryForToken(req.params.token)
  res.json({
    ...entry.state(),
    cache: store.stats()
  })
}))

// ---------------------------------------------------------------- media routes
app.get('/s/:token', wrap(async (req, res) => {
  const entry = await entryForToken(req.params.token)
  serveEntry(req, res, entry, { attachment: false })
}))

app.head('/s/:token', wrap(async (req, res) => {
  const entry = await entryForToken(req.params.token)
  serveEntry(req, res, entry, { attachment: false })
}))

app.get('/d/:token', wrap(async (req, res) => {
  const entry = await entryForToken(req.params.token)
  serveEntry(req, res, entry, { attachment: true })
}))

app.head('/d/:token', wrap(async (req, res) => {
  const entry = await entryForToken(req.params.token)
  serveEntry(req, res, entry, { attachment: true })
}))

// ---------------------------------------------------------------- frontend
const publicDir = path.join(config.root, 'public')

app.use(express.static(publicDir, {
  index: false,
  maxAge: '1h',
  setHeaders (res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'")
    }
  }
}))

app.get(['/v/:token', '/'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'")
  res.sendFile(path.join(publicDir, 'index.html'))
})

// ---------------------------------------------------------------- errors
app.use((err, req, res, next) => {
  if (res.headersSent) {
    res.destroy(err)
    return
  }
  const status = err.status || (err instanceof FillError ? err.status : 500)
  const code = err.code || 'INTERNAL'
  if (status >= 500) console.error('[error]', err)
  if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter))
  res.status(status).json({
    error: err.message || 'Internal error',
    code,
    retryAfter: err.retryAfter || null
  })
})

// ---------------------------------------------------------------- boot
await store.init()
app.listen(config.port, config.host, () => {
  console.log(`MegaDirect listening on http://${config.host}:${config.port}`)
  console.log(`  cache: ${config.cacheDir} (max ${config.cacheMaxBytes / 1024 ** 3} GB)`)
  console.log(`  demo mode: ${config.demoMode ? 'ON' : 'off'}`)
})
