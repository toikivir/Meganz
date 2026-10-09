/**
 * Direct mode — resolve and fetch MEGA links through the user's browser.
 *
 * Used automatically when the server cannot reach MEGA (locked-down hosting,
 * sandboxed previews…). The browser talks to MEGA's API directly (which sends
 * `Access-Control-Allow-Origin: *`), decrypts with megajs, and saves/plays
 * from memory. The server-cached path is always preferred when available.
 */

import { parseMegaLink } from '/lib/links.js'

const KINDS = {
  mp4: 'video', m4v: 'video', webm: 'video', ogv: 'video', mov: 'video', mkv: 'video', avi: 'video',
  mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image', bmp: 'image'
}
const PLAYABLE = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus'])
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', zip: 'application/zip'
}

function extOf (name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

function mediaInfo (name) {
  const ext = extOf(name)
  const kind = KINDS[ext] || 'other'
  return {
    mime: MIME[ext] || 'application/octet-stream',
    kind: ['video', 'audio'].includes(kind) ? kind : (kind === 'image' ? 'image' : 'other'),
    playable: PLAYABLE.has(ext)
  }
}

let megajsPromise = null
function loadMegajs () {
  if (!megajsPromise) megajsPromise = import('/vendor/megajs.mjs')
  return megajsPromise
}

function friendly (err) {
  const message = String((err && err.message) || err)
  if (/could not be decrypted|invalid key/i.test(message)) {
    return new Error('The decryption key in that link looks wrong or the link is corrupted.')
  }
  if (/not found|E(-\d+)?\b|object/i.test(message) && /not found|-9\b|-16\b/i.test(message)) {
    return new Error('MEGA says this link does not exist or was removed.')
  }
  if (/fetch|network|failed to fetch|load failed/i.test(message)) {
    return new Error('Your browser could not reach MEGA — check your connection or try again.')
  }
  return err instanceof Error ? err : new Error(message)
}

async function openNode (url) {
  const { File } = await loadMegajs()
  const link = parseMegaLink(url)
  const f = File.fromURL(link.canonical)
  let node
  try {
    node = await f.loadAttributes()
  } catch (err) {
    throw friendly(err)
  }
  return { link, node }
}

/** Same shape as the server's /api/info — {type:'folder'|'file', ...}. */
export async function directInfo (rawUrl) {
  const { link, node } = await openNode(rawUrl)

  if (link.kind === 'folder') {
    let count = 0
    const walk = (parent, depth) => {
      const out = []
      for (const child of parent.children || []) {
        if (count >= 1000 || depth > 8) break
        count++
        const name = child.name || '(unnamed)'
        if (child.directory) {
          out.push({ type: 'folder', name, children: walk(child, depth + 1) })
        } else {
          const handle = Array.isArray(child.downloadId) ? child.downloadId[1] : child.downloadId
          const media = mediaInfo(name)
          out.push({
            type: 'file',
            name,
            size: typeof child.size === 'number' ? child.size : 0,
            modified: typeof child.createdAt === 'number' ? child.createdAt : null,
            kind: media.kind,
            playable: media.playable,
            direct: true,
            directUrl: `https://mega.nz/folder/${link.downloadId}#${link.key}/file/${handle}`,
            links: {}
          })
        }
      }
      return out
    }
    const entries = walk(node, 0)
    const counts = { files: 0, folders: 0, bytes: 0 }
    const tally = (list) => {
      for (const e of list) {
        if (e.type === 'folder') { counts.folders++; tally(e.children) } else { counts.files++; counts.bytes += e.size }
      }
    }
    tally(entries)
    return {
      type: 'folder',
      direct: true,
      sourceUrl: link.canonical,
      name: node.name || 'MEGA folder',
      entries,
      counts,
      truncated: count >= 1000
    }
  }

  const name = node.name || 'mega-download'
  const media = mediaInfo(name)
  return {
    type: 'file',
    direct: true,
    sourceUrl: link.canonical,
    name,
    size: typeof node.size === 'number' ? node.size : 0,
    mime: media.mime,
    kind: media.kind,
    playable: media.playable,
    links: {}
  }
}

/** Download a whole file into a Blob through the browser. */
export async function directFetch (rawUrl, { onProgress } = {}) {
  const { node } = await openNode(rawUrl)
  const name = node.name || 'mega-download'
  const media = mediaInfo(name)
  const stream = node.download()
  const chunks = []
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk))
    if (onProgress) stream.on('progress', (p) => onProgress(p))
    stream.on('end', resolve)
    stream.on('error', (err) => reject(friendly(err)))
    stream.on('finish', resolve)
  })
  return new Blob(chunks, { type: media.mime })
}
