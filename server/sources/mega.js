import { File } from 'megajs'
import { Readable, Transform } from 'node:stream'
import { config } from '../config.js'
import { FillError } from '../cache.js'
import { encodeToken, parseMegaLink } from '../links.js'

const MAX_FOLDER_ENTRIES = 1000
const MAX_FOLDER_DEPTH = 8

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
        // Folder links are fine: loadAttributes() returns the folder root with
        // its children tree (list() walks it); file-in-folder links return the
        // target node; plain file links return the file.
        try {
          return await f.loadAttributes()
        } catch (err) {
          filePromise = null
          throw toFillError(err)
        }
      })()
    }
    return filePromise
  }

  function toFillError (err) {
    if (err instanceof FillError) return err
    const message = String(err && err.message ? err.message : err)
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EPIPE|ETIMEDOUT|getaddrinfo|socket hang up|network|certificate/i.test(message)) {
      return new FillError('Could not reach MEGA from this server — check its outbound connectivity.', {
        code: 'NETWORK',
        status: 502,
        retryAfter: 30
      })
    }
    return new FillError(message, { code: 'UPSTREAM', status: 502, retryAfter: 15 })
  }

  return {
    kind: 'mega',

    async resolve () {
      const f = await file()
      if (f.directory) {
        throw new FillError('This link points at a folder — browse it to pick files.', {
          code: 'IS_FOLDER',
          status: 400
        })
      }
      if (typeof f.size !== 'number') {
        throw new FillError('Could not read the file size from MEGA.', { code: 'UPSTREAM', status: 502 })
      }
      if (f.size > config.maxFileBytes) {
        throw new FillError('That file is larger than this server allows.', { code: 'TOO_LARGE', status: 413 })
      }
      return { name: f.name || 'mega-download', size: f.size }
    },

    /** List a public folder tree (names, sizes, per-file download tokens). */
    async list () {
      const root = await file()
      if (!root.directory) {
        throw new FillError('This link is a single file, not a folder.', { code: 'NOT_FOLDER', status: 400 })
      }
      const link = parseMegaLink(descriptor.u)
      let count = 0

      const walk = (node, depth) => {
        const out = []
        for (const child of node.children || []) {
          if (count >= MAX_FOLDER_ENTRIES) break
          count++
          const name = child.name || '(unnamed)'
          if (child.directory) {
            const entry = { type: 'folder', name, children: depth + 1 < MAX_FOLDER_DEPTH ? walk(child, depth + 1) : [] }
            out.push(entry)
          } else {
            // downloadId for shared-folder nodes is [folderHandle, nodeHandle]
            const nodeHandle = Array.isArray(child.downloadId) ? child.downloadId[1] : child.downloadId
            const subUrl = `https://mega.nz/folder/${link.downloadId}#${link.key}/file/${nodeHandle}`
            out.push({
              type: 'file',
              name,
              size: typeof child.size === 'number' ? child.size : 0,
              modified: typeof child.createdAt === 'number' ? child.createdAt : null,
              token: encodeToken({ u: subUrl })
            })
          }
        }
        return out
      }

      return {
        name: root.name || 'MEGA folder',
        entries: walk(root, 0),
        truncated: count >= MAX_FOLDER_ENTRIES
      }
    },

    async openRange (start, end) {
      const f = await file()
      if (f.directory) {
        throw new FillError('Folders cannot be downloaded as a single stream.', { code: 'IS_FOLDER', status: 400 })
      }
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
