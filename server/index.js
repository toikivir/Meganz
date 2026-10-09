import express from 'express'
import path from 'node:path'
import { config } from './config.js'
import { CacheStore, FillError } from './cache.js'
import { tokenFromInput, decodeToken, LinkError } from './links.js'
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

// ---------------------------------------------------------------- API
app.get('/api/health', (req, res) => {
  res.json({ ok: true, demoMode: config.demoMode })
})

app.get('/api/stats', apiLimiter, (req, res) => {
  res.json({ cache: store.stats(), demoMode: config.demoMode })
})

app.post('/api/info', resolveLimiter, wrap(async (req, res) => {
  const body = req.body || {}
  let input = body.url
  if (!input && body.demo) input = `demo:${body.demo}`
  const { token } = tokenFromInput(input)
  const entry = await entryForToken(token)
  res.json(describeEntry(entry, token))
}))

app.get('/api/info/:token', resolveLimiter, wrap(async (req, res) => {
  const entry = await entryForToken(req.params.token)
  res.json(describeEntry(entry, req.params.token))
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
