/* Custom media player: seeking, cached-range map, keyboard shortcuts. */

const $ = (id) => document.getElementById(id)

export function fmtTime (sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.floor(sec % 60)
  const m = Math.floor((sec / 60) % 60)
  const h = Math.floor(sec / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return (h > 0 ? `${h}:` : '') + mm + ':' + String(s).padStart(2, '0')
}

export function initPlayer ({ mediaUrl, kind }) {
  const media = $('media-el')
  const player = $('player')
  const overlay = $('player-overlay')
  const controls = $('controls')
  const playToggle = $('play-toggle')
  const bigPlay = $('big-play')
  const seekInput = $('seek-input')
  const seekPlayed = $('seek-played')
  const seekCached = $('seek-cached')
  const tCur = $('t-cur')
  const tDur = $('t-dur')
  const muteToggle = $('mute-toggle')
  const volume = $('volume')
  const speed = $('speed')
  const pipBtn = $('pip-btn')
  const fsBtn = $('fs-btn')
  const note = $('player-note')

  let duration = 0
  let scrubbing = false
  let hideTimer = null

  player.classList.toggle('audio-mode', kind === 'audio')
  media.src = mediaUrl
  note.textContent = kind === 'audio'
    ? 'Audio stream — the seek bar shows which parts are already cached on the server (blue).'
    : 'Tip: seek anywhere — cached regions (blue on the seek bar) start instantly, even backwards.'

  const setPlaying = (playing) => {
    player.classList.toggle('playing', playing)
    player.classList.toggle('paused', !playing)
    playToggle.textContent = playing ? '⏸' : '▶'
    scheduleHide()
  }

  const scheduleHide = () => {
    clearTimeout(hideTimer)
    player.classList.add('show-ui')
    if (!media.paused) {
      hideTimer = setTimeout(() => player.classList.remove('show-ui'), 2800)
    }
  }

  const toggle = () => {
    if (media.paused) media.play().catch(() => {})
    else media.pause()
  }

  playToggle.addEventListener('click', toggle)
  bigPlay.addEventListener('click', toggle)
  media.addEventListener('click', toggle)
  media.addEventListener('play', () => setPlaying(true))
  media.addEventListener('pause', () => setPlaying(false))
  media.addEventListener('ended', () => setPlaying(false))

  media.addEventListener('loadedmetadata', () => {
    duration = media.duration || 0
    tDur.textContent = fmtTime(duration)
  })
  media.addEventListener('durationchange', () => {
    duration = media.duration || duration
    tDur.textContent = fmtTime(duration)
  })
  media.addEventListener('timeupdate', () => {
    tCur.textContent = fmtTime(media.currentTime)
    if (!scrubbing && duration > 0) {
      const pct = (media.currentTime / duration) * 100
      seekPlayed.style.width = pct + '%'
      seekInput.value = String(Math.round(pct * 10))
    }
  })
  media.addEventListener('error', () => {
    note.textContent = 'Playback error — this format may not be supported by your browser. The Download button still works.'
    note.classList.add('error')
  })

  seekInput.addEventListener('input', () => {
    scrubbing = true
    const pct = Number(seekInput.value) / 1000
    seekPlayed.style.width = (pct * 100) + '%'
    tCur.textContent = fmtTime(pct * duration)
  })
  const commitSeek = () => {
    if (!scrubbing) return
    scrubbing = false
    if (duration > 0) media.currentTime = (Number(seekInput.value) / 1000) * duration
  }
  seekInput.addEventListener('change', commitSeek)
  seekInput.addEventListener('mouseup', commitSeek)
  seekInput.addEventListener('touchend', commitSeek)

  muteToggle.addEventListener('click', () => {
    media.muted = !media.muted
    muteToggle.textContent = media.muted ? '🔇' : '🔊'
  })
  volume.addEventListener('input', () => {
    media.volume = Number(volume.value)
    media.muted = media.volume === 0
    muteToggle.textContent = media.muted ? '🔇' : '🔊'
  })
  speed.addEventListener('change', () => {
    media.playbackRate = Number(speed.value)
  })

  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else if (document.pictureInPictureEnabled) await media.requestPictureInPicture()
    } catch { /* not supported */ }
  })

  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else player.requestFullscreen?.().catch(() => {})
  })

  const onKey = (e) => {
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return
    switch (e.key.toLowerCase()) {
      case ' ':
      case 'k':
        e.preventDefault()
        toggle()
        break
      case 'arrowleft':
        media.currentTime = Math.max(0, media.currentTime - 5)
        break
      case 'arrowright':
        media.currentTime = Math.min(duration || Infinity, media.currentTime + 5)
        break
      case 'arrowup':
        media.volume = Math.min(1, media.volume + 0.1)
        volume.value = String(media.volume)
        break
      case 'arrowdown':
        media.volume = Math.max(0, media.volume - 0.1)
        volume.value = String(media.volume)
        break
      case 'm':
        muteToggle.click()
        break
      case 'f':
        fsBtn.click()
        break
    }
    scheduleHide()
  }
  document.addEventListener('keydown', onKey)
  player.addEventListener('mousemove', scheduleHide)
  scheduleHide()

  return {
    media,
    updateCached (ranges, size) {
      if (!size) return
      seekCached.innerHTML = ''
      for (const [s, e] of ranges) {
        const seg = document.createElement('i')
        seg.style.left = (s / size) * 100 + '%'
        seg.style.width = Math.max(0.25, ((e - s + 1) / size) * 100) + '%'
        seekCached.appendChild(seg)
      }
    },
    destroy () {
      document.removeEventListener('keydown', onKey)
      clearTimeout(hideTimer)
      media.pause()
      media.removeAttribute('src')
      media.load()
    }
  }
}
