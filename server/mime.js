const TYPES = {
  // video
  mp4: ['video/mp4', 'video'],
  m4v: ['video/mp4', 'video'],
  webm: ['video/webm', 'video'],
  ogv: ['video/ogg', 'video'],
  mov: ['video/quicktime', 'video'],
  mkv: ['video/x-matroska', 'video'],
  avi: ['video/x-msvideo', 'video'],
  // audio
  mp3: ['audio/mpeg', 'audio'],
  m4a: ['audio/mp4', 'audio'],
  aac: ['audio/aac', 'audio'],
  wav: ['audio/wav', 'audio'],
  flac: ['audio/flac', 'audio'],
  ogg: ['audio/ogg', 'audio'],
  oga: ['audio/ogg', 'audio'],
  opus: ['audio/opus', 'audio'],
  // images
  jpg: ['image/jpeg', 'image'],
  jpeg: ['image/jpeg', 'image'],
  png: ['image/png', 'image'],
  gif: ['image/gif', 'image'],
  webp: ['image/webp', 'image'],
  svg: ['image/svg+xml', 'image'],
  avif: ['image/avif', 'image'],
  bmp: ['image/bmp', 'image'],
  // documents & archives
  pdf: ['application/pdf', 'other'],
  zip: ['application/zip', 'other'],
  rar: ['application/vnd.rar', 'other'],
  '7z': ['application/x-7z-compressed', 'other'],
  gz: ['application/gzip', 'other'],
  tar: ['application/x-tar', 'other'],
  txt: ['text/plain', 'other'],
  srt: ['text/plain', 'other'],
  sub: ['text/plain', 'other'],
  json: ['application/json', 'other'],
  csv: ['text/csv', 'other'],
  epub: ['application/epub+zip', 'other']
}

// Container extensions whose codecs are usually playable natively in browsers.
const PLAYABLE = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus'])

export function extOf (name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

export function detectMime (name) {
  const [mime] = TYPES[extOf(name)] || ['application/octet-stream', 'other']
  return mime
}

/** @returns {{mime:string, kind:string, playable:boolean}} */
export function mediaInfo (name) {
  const ext = extOf(name)
  const [mime, kind] = TYPES[ext] || ['application/octet-stream', 'other']
  return {
    mime,
    kind: kind === 'video' || kind === 'audio' ? kind : (kind === 'image' ? 'image' : 'other'),
    playable: PLAYABLE.has(ext) && (kind === 'video' || kind === 'audio')
  }
}

export function contentDisposition (name, disposition = 'attachment') {
  const safe = String(name || 'download').replace(/[\r\n"\\]/g, '_')
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${disposition}; filename*=UTF-8''${encoded}`
}
