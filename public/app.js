import { initPlayer } from './player.js'

const $ = (id) => document.getElementById(id)

function fmtBytes (n) {
  if (!Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + units[i]
}

async function api (path, options) {
  const res = await fetch(path, options)
  let data = null
  try {
    data = await res.json()
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`)
    err.code = data && data.code
    err.retryAfter = data && data.retryAfter
    err.status = res.status
    throw err
  }
  return data
}

const state = {
  info: null,
  player: null,
  pollTimer: null,
  lastCachedBytes: 0,
  lastPollAt: 0,
  folderContext: null // { token, info } while browsing a folder
}

// ---------------------------------------------------------------- UI helpers
function setFormStatus (message, kind = '') {
  const el = $('form-status')
  el.textContent = message
  el.className = 'form-status' + (kind ? ' ' + kind : '')
}

function friendlyError (err) {
  if (err.code === 'QUOTA') {
    return `MEGA transfer limit reached — the server will auto-retry${err.retryAfter ? ` in ${err.retryAfter}s` : ''}. Cached parts are still served.`
  }
  if (err.code === 'RATE_LIMIT') return 'Too many requests — give it a few seconds and try again.'
  if (err.code === 'FOLDER') return err.message
  return err.message || 'Something went wrong.'
}

// ---------------------------------------------------------------- folder browser
const KIND_ICONS = { video: '🎬', audio: '🎵', image: '🖼️', other: '📦' }

function fmtDate (ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

function fileEntryToInfo (entry) {
  return {
    type: 'file',
    token: entry.token,
    name: entry.name,
    size: entry.size,
    mime: null,
    kind: entry.kind,
    playable: entry.playable,
    demo: entry.demo || false,
    links: entry.links
  }
}

function renderTree (entries, container) {
  for (const entry of entries) {
    if (entry.type === 'folder') {
      const wrap = document.createElement('div')
      wrap.className = 'tree-folder open'

      const head = document.createElement('button')
      head.type = 'button'
      head.className = 'tree-row folder-row'

      const caret = document.createElement('span')
      caret.className = 'tree-caret'
      caret.textContent = '▾'
      const icon = document.createElement('span')
      icon.className = 'tree-icon'
      icon.textContent = '📁'
      const name = document.createElement('span')
      name.className = 'tree-name'
      name.textContent = entry.name
      const meta = document.createElement('span')
      meta.className = 'tree-meta'
      meta.textContent = `${(entry.children || []).length} item${(entry.children || []).length === 1 ? '' : 's'}`

      head.append(caret, icon, name, meta)

      const kids = document.createElement('div')
      kids.className = 'tree-kids'
      renderTree(entry.children || [], kids)

      head.addEventListener('click', () => {
        const open = wrap.classList.toggle('open')
        caret.textContent = open ? '▾' : '▸'
      })

      wrap.append(head, kids)
      container.appendChild(wrap)
    } else {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'tree-row file-row'

      const icon = document.createElement('span')
      icon.className = 'tree-icon'
      icon.textContent = KIND_ICONS[entry.kind] || '📄'
      const name = document.createElement('span')
      name.className = 'tree-name'
      name.textContent = entry.name
      const meta = document.createElement('span')
      meta.className = 'tree-meta'
      meta.textContent = [
        fmtBytes(entry.size),
        fmtDate(entry.modified),
        entry.playable ? '▶ playable' : ''
      ].filter(Boolean).join(' · ')

      row.append(icon, name, meta)

      if (entry.playable) {
        const badge = document.createElement('span')
        badge.className = 'tree-badge'
        badge.textContent = '▶'
        row.appendChild(badge)
      }
      const dl = document.createElement('span')
      dl.className = 'tree-dl'
      dl.title = 'Download this file'
      dl.textContent = '⤓'
      dl.addEventListener('click', (e) => {
        e.stopPropagation()
        window.location.href = entry.links.download
      })
      row.appendChild(dl)

      row.addEventListener('click', () => {
        selectFolderFile(entry)
      })

      container.appendChild(row)
    }
  }
}

function showFolder (info) {
  state.info = null
  state.folderContext = { token: info.token, info }
  if (state.player) {
    state.player.destroy()
    state.player = null
  }
  $('player-card').hidden = true
  $('file-card').style.display = 'none'
  $('back-btn').hidden = true

  const card = $('folder-card')
  card.hidden = false
  $('folder-title').textContent = info.name
  $('folder-title').title = info.name
  const c = info.counts || { files: 0, folders: 0, bytes: 0 }
  $('folder-sub').textContent =
    `${c.files} file${c.files === 1 ? '' : 's'}${c.folders ? ` · ${c.folders} sub-folder${c.folders === 1 ? '' : 's'}` : ''} · ${fmtBytes(c.bytes)}`
  $('folder-badge').textContent = info.truncated ? 'folder (partial listing)' : 'folder'

  const tree = $('folder-tree')
  tree.textContent = ''
  renderTree(info.entries || [], tree)

  $('result').hidden = false
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function hideFolder () {
  state.folderContext = null
  $('folder-card').hidden = true
  $('back-btn').hidden = true
}

function selectFolderFile (entry) {
  const info = fileEntryToInfo(entry)
  showFile(info)
  const back = $('back-btn')
  back.hidden = !state.folderContext
  back.onclick = () => {
    if (state.folderContext) {
      const ctx = state.folderContext
      history.replaceState(null, '', `/v/${ctx.token}`)
      showFolder(ctx.info)
    }
  }
}

// ---------------------------------------------------------------- result card
function showFile (info) {
  state.info = info
  const result = $('result')
  result.hidden = false
  $('file-card').style.display = ''

  $('file-icon').textContent = KIND_ICONS[info.kind] || '📄'
  $('file-name').textContent = info.name
  $('file-name').title = info.name
  $('file-size').textContent = fmtBytes(info.size)
  $('file-kind').textContent =
    info.kind === 'video' ? 'Video' : info.kind === 'audio' ? 'Audio' : info.kind === 'image' ? 'Image' : 'File'

  const dl = $('download-btn')
  dl.href = info.links.download

  const playBtn = $('play-btn')
  if (info.playable) {
    playBtn.hidden = false
    playBtn.textContent = info.kind === 'audio' ? '▶ Play audio' : '▶ Play online'
    playBtn.onclick = () => openPlayer(info)
  } else {
    playBtn.hidden = true
  }

  $('copy-btn').onclick = async () => {
    const url = location.origin + info.links.watch
    try {
      await navigator.clipboard.writeText(url)
      $('copy-btn').textContent = '✓ Copied!'
    } catch {
      prompt('Copy this link:', url)
    }
    setTimeout(() => { $('copy-btn').textContent = '⧉ Copy link' }, 1800)
  }

  if (state.player) {
    state.player.destroy()
    state.player = null
  }
  $('player-card').hidden = true

  startPolling()
  result.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function openPlayer (info) {
  $('player-card').hidden = false
  if (state.player) state.player.destroy()
  state.player = initPlayer({
    mediaUrl: info.links.stream,
    kind: info.kind
  })
  state.player.updateCached(state.lastRanges || [], info.size)
  $('player-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

// ---------------------------------------------------------------- state polling
function startPolling () {
  if (state.pollTimer) clearInterval(state.pollTimer)
  state.lastCachedBytes = 0
  state.lastPollAt = Date.now()
  const tick = () => pollState().catch(() => {})
  tick()
  state.pollTimer = setInterval(tick, 1500)
}

async function pollState () {
  if (!state.info) return
  const s = await api(`/api/state/${state.info.token}`)
  const pct = s.size > 0 ? (s.cachedBytes / s.size) * 100 : 100
  $('progress-fill').style.width = pct + '%'

  const badge = $('cache-badge')
  badge.textContent = pct >= 100 ? 'cached ✓' : `${Math.floor(pct)}% cached`
  badge.classList.toggle('cached', pct >= 100)

  const label = $('progress-label')
  const now = Date.now()
  const dt = (now - state.lastPollAt) / 1000
  const speedBps = dt > 0 ? (s.cachedBytes - state.lastCachedBytes) / dt : 0
  state.lastCachedBytes = s.cachedBytes
  state.lastPollAt = now

  if (s.complete) {
    label.textContent = `Fully cached on the server — downloads and plays are instant for everyone · ${fmtBytes(s.size)}`
  } else if (s.error && s.error.code === 'QUOTA') {
    label.textContent = `MEGA transfer limit reached — auto-retrying${s.error.retryAfter ? ` in ${s.error.retryAfter}s` : ''} · ${fmtBytes(s.cachedBytes)} / ${fmtBytes(s.size)} cached`
  } else if (s.error) {
    label.textContent = `Upstream problem: ${s.error.message} · will keep retrying`
  } else if (s.filling) {
    const sp = speedBps > 0 ? ` · ${fmtBytes(speedBps)}/s` : ''
    label.textContent = `Caching ${fmtBytes(s.cachedBytes)} / ${fmtBytes(s.size)}${sp}`
  } else {
    label.textContent = `Cached ${fmtBytes(s.cachedBytes)} / ${fmtBytes(s.size)}`
  }

  state.lastRanges = s.cachedRanges
  if (state.player) state.player.updateCached(s.cachedRanges, s.size)
}

// ---------------------------------------------------------------- input flow
async function resolveInput (payload) {
  setFormStatus('Fetching file info…')
  $('fetch-btn').disabled = true
  try {
    const info = await api('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (info.type === 'folder') {
      setFormStatus(`Ready: ${info.name}`, 'ok')
      history.replaceState(null, '', `/v/${info.token}`)
      showFolder(info)
    } else {
      setFormStatus(`Ready: ${info.name}`, 'ok')
      history.replaceState(null, '', info.links.watch)
      hideFolder()
      showFile(info)
    }
  } catch (err) {
    setFormStatus(friendlyError(err), 'error')
  } finally {
    $('fetch-btn').disabled = false
  }
}

$('link-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const url = $('link-input').value.trim()
  if (!url) {
    setFormStatus('Paste a mega.nz file link first.', 'error')
    return
  }
  resolveInput({ url })
})

for (const chip of document.querySelectorAll('[data-demo]')) {
  chip.addEventListener('click', () => {
    $('link-input').value = ''
    resolveInput({ demo: chip.dataset.demo })
  })
}

// ---------------------------------------------------------------- boot
async function boot () {
  // Demo row
  try {
    const health = await api('/api/health')
    if (health.demoMode) $('demo-row').hidden = false
  } catch { /* server not ready */ }

  // Footer stats
  try {
    const stats = await api('/api/stats')
    $('footer-stats').textContent =
      `Server cache: ${stats.cache.files} file${stats.cache.files === 1 ? '' : 's'} · ${fmtBytes(stats.cache.bytes)} of ${fmtBytes(stats.cache.maxBytes)}`
  } catch { /* ignore */ }

  // Watch page: /v/<token>
  const m = /^\/v\/([\w-]+)$/.exec(location.pathname)
  if (m) {
    setFormStatus('Loading…')
    try {
      const info = await api(`/api/info/${m[1]}`)
      setFormStatus(`Ready: ${info.name}`, 'ok')
      $('link-input').value = ''
      if (info.type === 'folder') {
        showFolder(info)
      } else {
        hideFolder()
        showFile(info)
        if (info.playable) openPlayer(info)
      }
    } catch (err) {
      setFormStatus(friendlyError(err), 'error')
    }
  }
}

boot()
