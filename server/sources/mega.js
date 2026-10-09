import { File } from 'megajs'
import { Readable, Transform } from 'node:stream'
import { config } from '../config.js'
import { FillError } from '../cache.js'

function limiter (stream, maxBytes) {
  let sent = 0
  const out = new Transform({
    transform (chunk, _enc, cb) {
      if (sent + chunk.length > maxBytes) {
        if (maxBytes > sent) this.push(chunk.subarray(0, maxBytes - sent))
        sent = maxBytes
        cb()
        this.push(null)
        return
      }
      sent += chunk.length
      cb(null, chunk)
    }
  })
  stream.on('error', (err) => out.destroy(err))
  stream.pipe(out)
  return out
}

/**
 * Source backed by a public MEGA link via the megajs SDK.
 * @param {{u: string}} descriptor
 */
export function createMegaSource (descriptor) {
  let filePromise = null

  function file () {
    if (!filePromise) {
      filePromise = (async () => {
        let f
        try {
          f = File.fromURL(descriptor.u)
        } catch (err) {
          throw new FillError(`Invalid MEGA link: ${err.message}`, { code: 'BAD_LINK', status: 400 })
        }
        if (f.directory && !f.loadedFile) {
          throw new FillError('Folder links are not supported yet — copy the link of a single file.', {
            code: 'FOLDER',
            status: 400
          })
        }
        try {
          return await f.loadAttributes()
        } catch (err) {
          filePromise = null
          throw err
        }
      })()
    }
    return filePromise
  }

  return {
    kind: 'mega',

    async resolve () {
      const f = await file()
      if (typeof f.size !== 'number') {
        throw new FillError('Could not read the file size from MEGA.', { code: 'UPSTREAM', status: 502 })
      }
      if (f.size > config.maxFileBytes) {
        throw new FillError('That file is larger than this server allows.', { code: 'TOO_LARGE', status: 413 })
      }
      return { name: f.name || 'mega-download', size: f.size }
    },

    async openRange (start, end) {
      const f = await file()
      if (f.size === 0) return Readable.from([])
      // megajs treats `end: 0` as "until EOF"; avoid that trap for single-byte ranges.
      const reqEnd = end === 0 ? Math.min(f.size - 1, 15) : end
      const stream = f.download({
        start,
        end: reqEnd,
        maxConnections: config.megaConnections
      })
      return limiter(stream, end - start + 1)
    }
  }
}
