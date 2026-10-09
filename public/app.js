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
  lastPollAt: 0
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

// ---------------------------------------------------------------- result card
function showFile (info) {
  state.info = info
  const result = $('result')
  result.hidden = false

  const icons = { video: '🎬', audio: '🎵', image: '🖼️', other: '📦' }
  $('file-icon').textContent = icons[info.kind] || '📄'
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
    setFormStatus(`Ready: ${info.name}`, 'ok')
    history.replaceState(null, '', info.links.watch)
    showFile(info)
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
    setFormStatus('Loading file…')
    try {
      const info = await api(`/api/info/${m[1]}`)
      setFormStatus(`Ready: ${info.name}`, 'ok')
      $('link-input').value = ''
      showFile(info)
      if (info.playable) openPlayer(info)
    } catch (err) {
      setFormStatus(friendlyError(err), 'error')
    }
  }
}

boot()
