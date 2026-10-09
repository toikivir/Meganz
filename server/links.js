/**
 * Parsing, validation and tokenisation of MEGA links.
 *
 * Supported public link formats (single files and single files out of folders):
 *   https://mega.nz/file/<id>#<key>
 *   https://mega.nz/folder/<id>#<key>/file/<sub>
 *   https://mega.nz/#!<id>!<key>
 *   https://mega.nz/#F!<id>!<key>!<sub>
 *   (same with mega.co.nz, and with or without the https:// prefix)
 */

const HOSTS = new Set(['mega.nz', 'mega.co.nz'])
const ID_RE = /^[\w-]+$/

export class LinkError extends Error {
  constructor (message, code = 'BAD_LINK') {
    super(message)
    this.code = code
    this.status = 400
  }
}

function normalizeInput (raw) {
  let s = String(raw || '').trim()
  if (!s) throw new LinkError('Please paste a MEGA link.')
  // Accept pastes without a scheme and with surrounding junk.
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?(?:mega\.nz|mega\.co\.nz)/i, (m) => m.toLowerCase().startsWith('http') ? m : `https://${m.replace(/^www\./i, '')}`)
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  let url
  try {
    url = new URL(s)
  } catch {
    throw new LinkError('That does not look like a valid URL.')
  }
  const host = url.hostname.toLowerCase()
  if (!HOSTS.has(host)) throw new LinkError('Only mega.nz (and mega.co.nz) links are supported.')
  return url
}

/**
 * @returns {{kind:'file'|'folder-file'|'folder', downloadId:string, key:string, loadedFile?:string, canonical:string}}
 */
export function parseMegaLink (raw) {
  const url = normalizeInput(raw)
  const hash = url.hash || ''

  // New style: /file/<id>#<key>  |  /folder/<id>#<key>/file/<sub>
  const pathMatch = url.pathname.match(/^\/(file|folder)\/([\w-]+)$/)
  if (pathMatch) {
    const [, type, downloadId] = pathMatch
    const parts = hash.replace(/^#/, '').split('/file/')
    const key = parts[0]
    const loadedFile = parts[1] || undefined
    if (!key || (loadedFile && !ID_RE.test(loadedFile))) {
      throw new LinkError('That link is missing its decryption key.')
    }
    if (type === 'folder' && !loadedFile) {
      throw new LinkError(
        'Folder links are not supported yet. Open the folder on MEGA and copy the link of a single file inside it.',
        'FOLDER'
      )
    }
    return {
      kind: type === 'folder' ? 'folder-file' : 'file',
      downloadId,
      key,
      loadedFile,
      canonical: type === 'folder'
        ? `https://mega.nz/folder/${downloadId}#${key}/file/${loadedFile}`
        : `https://mega.nz/file/${downloadId}#${key}`
    }
  }

  // Old style: #!<id>!<key>  |  #F!<id>!<key>!<sub>
  const split = hash.split('!')
  if ((split[0] === '#' || split[0] === '#F') && split.length >= 3) {
    const folder = split[0] === '#F'
    const [, downloadId, key, loadedFile] = split
    if (!downloadId || !key) throw new LinkError('That link is missing its decryption key.')
    if (folder && !loadedFile) {
      throw new LinkError(
        'Folder links are not supported yet. Open the folder on MEGA and copy the link of a single file inside it.',
        'FOLDER'
      )
    }
    return {
      kind: folder ? 'folder-file' : 'file',
      downloadId,
      key,
      loadedFile,
      canonical: folder
        ? `https://mega.nz/folder/${downloadId}#${key}/file/${loadedFile}`
        : `https://mega.nz/file/${downloadId}#${key}`
    }
  }

  throw new LinkError('Unrecognized MEGA link format. Paste a public file link ("Get link" in MEGA).')
}

const DEMO_KINDS = new Set(['video', 'audio', 'file'])

/** Compact, shareable token that carries the source descriptor. */
export function encodeToken (descriptor) {
  return Buffer.from(JSON.stringify(descriptor), 'utf8').toString('base64url')
}

export function decodeToken (token) {
  if (typeof token !== 'string' || !/^[\w-]{8,2048}$/.test(token)) {
    throw new LinkError('Invalid link token.')
  }
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new LinkError('Invalid link token.')
  }
  if (parsed && parsed.demo) {
    if (!DEMO_KINDS.has(parsed.demo)) throw new LinkError('Unknown demo file.')
    return { demo: parsed.demo }
  }
  if (parsed && typeof parsed.u === 'string') {
    const link = parseMegaLink(parsed.u) // re-validates host + format
    return link
  }
  throw new LinkError('Invalid link token.')
}

/** Descriptor -> token, given raw user input (URL or "demo:video"). */
export function tokenFromInput (raw) {
  const s = String(raw || '').trim()
  if (/^demo:(video|audio|file)$/i.test(s)) {
    return { descriptor: { demo: s.split(':')[1].toLowerCase() }, token: encodeToken({ demo: s.split(':')[1].toLowerCase() }) }
  }
  const link = parseMegaLink(s)
  const descriptor = { u: link.canonical }
  return { descriptor, token: encodeToken(descriptor) }
}
