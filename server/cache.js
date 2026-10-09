/**
 * Persistent sparse byte-range cache.
 *
 * Every byte pulled from a source (MEGA or demo) is written to a sparse file
 * on disk and recorded in a journal, so each file is fetched at most once.
 * Requests are served straight from disk when possible; missing ranges are
 * downloaded once (serialized per file — never twice) and served live while
 * they stream in. That is what makes the quota wall disappear for visitors.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { RangeSet } from './ranges.js'

const READ_CHUNK = 512 * 1024

/** Global cap on parallel upstream fetches across all files. */
class Semaphore {
  constructor (limit) {
    this.limit = limit
    this.active = 0
    this.queue = []
  }

  async acquire () {
    if (this.active < this.limit) {
      this.active++
      return
    }
    await new Promise((resolve) => this.queue.push(resolve))
    this.active++
  }

  release () {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

export class FillError extends Error {
  constructor (message, { code = 'UPSTREAM', retryAfter = null, status = 502 } = {}) {
    super(message)
    this.code = code
    this.retryAfter = retryAfter
    this.status = status
  }
}

export function idForDescriptor (descriptor) {
  return crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex').slice(0, 24)
}

class CacheEntry extends EventEmitter {
  constructor (store, { id, descriptor, name, size, mime, createdAt }) {
    super()
    this.store = store
    this.id = id
    this.descriptor = descriptor
    this.name = name
    this.size = size
    this.mime = mime
    this.ranges = new RangeSet()
    this.lastAccess = Date.now()
    this.lastError = null
    this.retryAt = 0
    this.activeReaders = 0
    this.filling = false
    this.source = null
    this.createdAt = createdAt || Date.now()
    this.priority = []
    this.failures = 0

    this.dataPath = path.join(store.dir, `${id}.bin`)
    this.journalPath = path.join(store.dir, `${id}.ranges`)
    this.metaPath = path.join(store.dir, `${id}.json`)
    this.ready = null
    this.fh = null
  }

  get complete () {
    return this.size === 0 || this.ranges.has(0, this.size - 1)
  }

  get cachedBytes () {
    return this.ranges.bytes
  }

  touch () {
    this.lastAccess = Date.now()
  }

  attachSource (source) {
    this.source = source
    this.lastError = null
    return this
  }

  async open () {
    if (this.ready) return this.ready
    this.ready = (async () => {
      await fsp.mkdir(this.store.dir, { recursive: true })
      let created = false
      try {
        await fsp.access(this.dataPath)
      } catch {
        created = true
      }
      this.fh = await fsp.open(this.dataPath, created ? 'w+' : 'r+')
      if (created && this.size > 0) await this.fh.truncate(this.size)
      await this.replayJournal()
      await this.saveMeta()
      return this
    })()
    return this.ready
  }

  async replayJournal () {
    try {
      const text = await fsp.readFile(this.journalPath, 'utf8')
      for (const line of text.split('\n')) {
        const m = /^(\d+) (\d+)$/.exec(line)
        if (m) this.ranges.add(Number(m[1]), Number(m[2]))
      }
    } catch {
      /* no journal yet */
    }
  }

  async saveMeta () {
    const meta = {
      id: this.id,
      descriptor: this.descriptor,
      name: this.name,
      size: this.size,
      mime: this.mime,
      createdAt: this.createdAt,
      lastAccess: this.lastAccess
    }
    await fsp.writeFile(this.metaPath, JSON.stringify(meta))
  }

  ensureSource () {
    if (!this.source && this.store.sourceFactory) {
      this.source = this.store.sourceFactory(this.descriptor)
    }
    return this.source
  }

  availableFrom (pos) {
    return this.ranges.availableFrom(pos)
  }

  has (start, end) {
    return this.ranges.has(start, end)
  }

  firstMissing (start, end) {
    return this.ranges.firstMissing(start, end)
  }

  async readBuffer (pos, length) {
    await this.open()
    const buf = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await this.fh.read(buf, read, length - read, pos + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return read === length ? buf : buf.subarray(0, read)
  }

  async write (pos, chunk) {
    await this.open()
    let written = 0
    while (written < chunk.length) {
      const { bytesWritten } = await this.fh.write(chunk, written, chunk.length - written, pos + written)
      if (bytesWritten === 0) throw new FillError('Disk write failed', { code: 'CACHE_IO', status: 500 })
      written += bytesWritten
    }
    await fsp.appendFile(this.journalPath, `${pos} ${pos + chunk.length - 1}\n`)
    this.ranges.add(pos, pos + chunk.length - 1)
    this.touch()
    this.store.account()
    this.emit('available', { start: pos, end: pos + chunk.length - 1 })
    if (this.complete) this.emit('complete')
  }

  requestFill (start, end) {
    if (!this.ensureSource()) return
    if (!this.priority.some((p) => p.start <= start && end <= p.end)) {
      this.priority.unshift({ start, end })
    }
    this.kick()
  }

  kick () {
    if (this.complete) return
    if (this.filling) return
    const delay = Math.max(0, this.retryAt - Date.now())
    if (delay > 0) {
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          this.kick()
        }, Math.min(delay, 60_000))
      }
      return
    }
    this.filling = true
    this.emit('fill-state')
    this.fillLoop()
      .catch((err) => {
        this.lastError = err
        if (err instanceof FillError) {
          this.retryAt = Date.now() + (err.retryAfter ? err.retryAfter * 1000 : 15_000)
        } else {
          this.failures++
          this.retryAt = Date.now() + Math.min(30_000, 2 ** this.failures * 1000)
        }
        this.emit('fill-error', err)
        // Keep retrying in the background while anyone still wants data.
        if (this.priority.length > 0 || this.activeReaders > 0) {
          if (!this.retryTimer) {
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null
              this.kick()
            }, Math.max(0, this.retryAt - Date.now()))
          }
        }
      })
      .finally(() => {
        this.filling = false
        this.emit('fill-state')
      })
  }

  nextSegment () {
    this.priority = this.priority.filter((p) => !this.ranges.has(p.start, p.end))
    for (const p of this.priority) {
      const miss = this.ranges.firstMissing(p.start, p.end)
      if (miss) return this.cap(miss)
    }
    const store = this.store
    if (store.prefetch && this.size <= store.prefetchMaxBytes) {
      const miss = this.ranges.firstMissing(0, this.size - 1)
      if (miss) return this.cap(miss)
    }
    return null
  }

  cap (miss) {
    return { start: miss.start, end: Math.min(miss.end, miss.start + this.store.segmentBytes - 1) }
  }

  async fillLoop () {
    const semaphore = this.store.semaphore
    while (true) {
      const seg = this.nextSegment()
      if (!seg) {
        this.failures = 0
        return
      }
      await semaphore.acquire()
      try {
        await this.fetchSegment(seg)
      } finally {
        semaphore.release()
      }
    }
  }

  async fetchSegment ({ start, end }) {
    const source = this.ensureSource()
    if (!source) throw new FillError('No source attached', { code: 'NO_SOURCE' })
    let stream
    try {
      stream = await this.source.openRange(start, end)
    } catch (err) {
      throw this.wrapSourceError(err)
    }
    let pos = start
    try {
      for await (const chunk of stream) {
        if (chunk.length === 0) continue
        const slice = pos + chunk.length - 1 > end ? chunk.subarray(0, end - pos + 1) : chunk
        if (slice.length === 0) break
        await this.write(pos, slice)
        pos += slice.length
        if (pos > end) break
      }
    } catch (err) {
      throw this.wrapSourceError(err)
    }
    if (pos <= end) {
      throw new FillError('Source ended before the requested range was complete', { code: 'SHORT_READ' })
    }
  }

  wrapSourceError (err) {
    if (err instanceof FillError) return err
    const message = String(err && err.message ? err.message : err)
    if (err && (err.code === 'QUOTA' || /bandwidth limit|over quota|509/i.test(message))) {
      const seconds = Number(err.timeLimit || err.retryAfter || 30)
      return new FillError(`MEGA transfer limit reached — retrying in ${seconds}s`, {
        code: 'QUOTA',
        retryAfter: Number.isFinite(seconds) ? seconds : 30,
        status: 503
      })
    }
    if (/rate limit|invalid response/i.test(message)) {
      return new FillError('MEGA is rate-limiting this server right now', { code: 'RATE', retryAfter: 30, status: 503 })
    }
    return new FillError(message, { code: 'UPSTREAM', retryAfter: 15, status: 502 })
  }

  /** Resolves when at least one byte at `pos` is cached, or rejects when the fill died. */
  waitForBytes (pos) {
    return new Promise((resolve, reject) => {
      let settled = false
      let nudged = false
      let timer = null
      const cleanup = () => {
        settled = true
        this.off('available', onState)
        this.off('fill-state', onState)
        this.off('fill-error', onState)
        if (timer) clearInterval(timer)
      }
      const check = () => {
        if (settled) return
        if (this.ranges.availableFrom(pos) > 0) {
          cleanup()
          resolve()
        } else if (!this.filling && !this.retryTimer && this.lastError && Date.now() >= this.retryAt) {
          cleanup()
          reject(this.lastError)
        } else if (!this.filling && !this.retryTimer && !this.lastError && this.ranges.firstMissing(pos, pos)) {
          // Nothing is running and our byte is still missing — nudge the filler
          // (unless the fill policy intentionally stopped: prefetch off).
          if (!nudged && (this.store.prefetch || this.priority.length > 0)) {
            nudged = true
            this.kick()
          }
        }
      }
      const onState = () => check()
      this.on('available', onState)
      this.on('fill-state', onState)
      this.on('fill-error', onState)
      timer = setInterval(check, 500)
      check()
    })
  }

  createReadStream (start, end) {
    return new CacheReadStream(this, start, end)
  }

  state () {
    return {
      id: this.id,
      name: this.name,
      size: this.size,
      mime: this.mime,
      cachedRanges: this.ranges.toJSON(),
      cachedBytes: this.cachedBytes,
      complete: this.complete,
      filling: this.filling,
      error: this.lastError ? { message: this.lastError.message, code: this.lastError.code, retryAfter: this.lastError.retryAfter } : null
    }
  }

  async destroy () {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.fh) await this.fh.close().catch(() => {})
    this.fh = null
    for (const file of [this.dataPath, this.journalPath, this.metaPath]) {
      await fsp.unlink(file).catch(() => {})
    }
  }
}

class CacheReadStream extends Readable {
  constructor (entry, start, end) {
    super({ highWaterMark: READ_CHUNK })
    this.entry = entry
    this.pos = start
    this.end = end
    this.pumping = false
    entry.activeReaders++
    entry.touch()
  }

  _read () {
    this.pump()
  }

  _destroy (err, cb) {
    this.entry.activeReaders = Math.max(0, this.entry.activeReaders - 1)
    cb(err)
  }

  async pump () {
    if (this.pumping || this.destroyed) return
    this.pumping = true
    try {
      while (!this.destroyed) {
        if (this.pos > this.end) {
          this.push(null)
          break
        }
        const avail = this.entry.availableFrom(this.pos)
        if (avail <= 0) {
          this.entry.requestFill(this.pos, this.end)
          await this.entry.waitForBytes(this.pos)
          continue
        }
        const len = Math.min(avail, this.end - this.pos + 1, READ_CHUNK)
        const buf = await this.entry.readBuffer(this.pos, len)
        if (buf.length === 0) {
          throw new FillError('Cache read returned no data', { code: 'CACHE_IO', status: 500 })
        }
        this.pos += buf.length
        if (!this.push(buf)) break
      }
    } catch (err) {
      this.destroy(err)
    } finally {
      this.pumping = false
    }
  }
}

export class CacheStore {
  constructor ({ dir, maxBytes, prefetch = true, prefetchMaxBytes = 0, segmentBytes = 8 * 1024 * 1024, maxParallelFetches = 2, sourceFactory }) {
    this.dir = dir
    this.maxBytes = maxBytes
    this.prefetch = prefetch
    this.prefetchMaxBytes = prefetchMaxBytes
    this.segmentBytes = segmentBytes
    this.semaphore = new Semaphore(maxParallelFetches)
    this.sourceFactory = sourceFactory
    this.entries = new Map()
    this.accountTimer = null
  }

  async init () {
    await fsp.mkdir(this.dir, { recursive: true })
    const files = await fsp.readdir(this.dir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(this.dir, file), 'utf8'))
        if (!meta || !meta.id || typeof meta.size !== 'number') continue
        const entry = new CacheEntry(this, meta)
        await entry.open()
        if (entry.complete || entry.cachedBytes > 0) {
          this.entries.set(entry.id, entry)
        } else {
          await entry.destroy()
        }
      } catch {
        /* ignore corrupt meta */
      }
    }
    this.account()
    this.accountTimer = setInterval(() => {
      this.enforceLimit()
      for (const entry of this.entries.values()) {
        entry.saveMeta().catch(() => {})
        if (!entry.complete && entry.activeReaders > 0) entry.kick()
      }
    }, 60_000)
    this.accountTimer.unref?.()
  }

  totalBytes () {
    let total = 0
    for (const entry of this.entries.values()) total += entry.cachedBytes
    return total
  }

  account () {
    this.enforceLimit()
  }

  enforceLimit () {
    if (this.totalBytes() <= this.maxBytes) return
    const victims = [...this.entries.values()]
      .filter((e) => e.activeReaders === 0)
      .sort((a, b) => a.lastAccess - b.lastAccess)
    for (const entry of victims) {
      if (this.totalBytes() <= this.maxBytes) break
      this.entries.delete(entry.id)
      entry.destroy().catch(() => {})
    }
  }

  /**
   * Get (or create) the cache entry for a descriptor.
   * `resolve` is only called when the file is not already known on disk.
   */
  async getEntry (descriptor, resolve) {
    const id = idForDescriptor(descriptor)
    if (this.entries.has(id)) {
      const entry = this.entries.get(id)
      entry.touch()
      await entry.open()
      return entry
    }
    // Meta may exist on disk (from a previous run) even if not in the map yet.
    const metaPath = path.join(this.dir, `${id}.json`)
    let meta = null
    try {
      meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
    } catch { /* not cached yet */ }

    let source = null
    if (!meta || typeof meta.size !== 'number') {
      source = this.sourceFactory(descriptor)
      const info = await resolve(source)
      meta = { id, descriptor, name: info.name, size: info.size, mime: info.mime }
    }
    const entry = new CacheEntry(this, meta)
    if (source) entry.attachSource(source)
    await entry.open()
    this.entries.set(id, entry)
    this.account()
    return entry
  }

  stats () {
    return {
      files: this.entries.size,
      bytes: this.totalBytes(),
      maxBytes: this.maxBytes
    }
  }
}
