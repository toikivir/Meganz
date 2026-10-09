# MegaDirect

**Direct downloads & fast online video streaming for public [mega.nz](https://mega.nz) links — without the quota wall.**

Paste a public MEGA file link, get a permanent direct download URL and (for media) a built-in
player with real seeking. The server fetches each file from MEGA **once** into a local cache and
serves every visitor from disk afterwards — so your users never see MEGA's "transfer quota
exceeded" screens.

## Features

- ⚡ **Quota-free for visitors** — files are fetched once and cached on disk (sparse byte-range
  cache with journaling). Repeat downloads, plays and restarts cost zero MEGA bandwidth.
- 🎬 **Instant video streaming** — HTTP byte-range streaming over the decrypted file: seek
  anywhere, instantly inside cached regions, streaming straight from MEGA elsewhere.
- 🔗 **Real direct links** — permanent per-file URLs with `Range`/`Accept-Ranges` support that
  work with any download manager, pause/resume included.
- ▶ **Watch pages** — share `/v/<token>` and anyone can play the file in the browser, no account
  and no MEGA app required.
- 🧩 **All public link formats** — `mega.nz/file/…#…`, `mega.nz/#!…!…`, files inside shared
  folders (`/folder/…#…/file/…`), and **full folder links** with an in-page tree browser.
- 📁 **Folder browsing** — paste a folder link, expand sub-folders inline, filter by name,
  multi-select files for batch download, and download or play any file you pick. Files opened
  from a folder link get a "Browse folder" button back to their parent folder.
- 🚫 **No accounts, no tracking** — no login, no analytics; link keys live only inside the token
  and the server cache.

## Quick start

```bash
npm install
npm start                # production
# or
npm run demo             # with built-in demo files (no MEGA account/link needed)
```

Open http://localhost:8080.

Try the demo buttons in the UI (demo mode) to see downloads and streaming without a real MEGA
link, or paste any public MEGA file link.

```bash
npm test                 # smoke test against the demo source
```

## How the "no quota" part works

MEGA applies transfer quotas per IP address. MegaDirect moves that cost to the server and makes
it one-time:

1. When someone requests a file, the server starts a **serialized background fetch** (never the
   same byte twice, even with concurrent visitors).
2. Every decrypted byte is written to a **sparse cache file** and journaled, so it survives
   restarts and can be served at any offset.
3. Clients are streamed **as the cache fills** — the first bytes arrive as soon as MEGA delivers
   them; already-cached ranges are served at disk speed.
4. If MEGA raises its bandwidth limit (HTTP 509), the cache keeps what it has, the fetch
   auto-retries when the limit resets, and API responses carry `Retry-After`.
5. Files smaller than `PREFETCH_MAX_GB` keep downloading in the background until fully cached.

Operators still use their own server's bandwidth quota for the first fetch of each file — keep
an eye on it if you host large public files.

## Supported links

| Format | Example | Status |
| --- | --- | --- |
| New file link | `https://mega.nz/file/AbCd1234#Key` | ✅ |
| Legacy file link | `https://mega.nz/#!AbCd1234!Key` | ✅ |
| Folder link | `https://mega.nz/folder/AbCd#Key` | ✅ browse & pick files |
| Legacy folder link | `https://mega.nz/#F!AbCd1234!Key` | ✅ browse & pick files |
| File inside folder | `https://mega.nz/folder/AbCd#Key/file/Sub123` | ✅ |

## API

| Route | Description |
| --- | --- |
| `POST /api/info` `{url}` | Resolve a link → file info or a folder tree with per-file tokens |
| `GET /api/info/:token` | Same, for an existing token |
| `GET /api/folder/:token` | Folder tree: names, sizes, playable flags, per-file tokens |
| `GET /api/state/:token` | Cache state: cached byte ranges, progress, errors |
| `GET /s/:token` | Stream inline (range-capable) — used by the player |
| `GET /d/:token` | Download as attachment (range-capable, resumable) |
| `GET /v/:token` | Watch page (shareable) |
| `GET /api/stats` | Cache statistics |
| `GET /api/health` | Liveness |

Tokens are compact base64url descriptors; the direct URL is all anyone needs to download or play.

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `CACHE_DIR` | `.cache/` | Where cached files live |
| `CACHE_MAX_GB` | `20` | Cache size limit (LRU eviction of idle files) |
| `MAX_FILE_GB` | `50` | Refuse files larger than this |
| `PREFETCH` | `1` | Keep filling files in the background (`0` = only requested ranges) |
| `PREFETCH_MAX_GB` | `4` | Background-fill cutoff; larger files cache on demand |
| `SEGMENT_MB` | `8` | Upstream fetch granularity |
| `MEGA_CONNECTIONS` | `4` | Parallel connections per MEGA fetch |
| `DEMO_MODE` | `0` | `1` = show demo files (no MEGA required) |
| `TRUST_PROXY` | `0` | `1` = trust `X-Forwarded-For` (behind a reverse proxy) |

## Architecture

```
server/
  index.js          Express app: API + range streaming + watch pages
  cache.js          Sparse byte-range cache, serialized fills, LRU eviction
  links.js          MEGA link parsing/validation + shareable tokens
  ranges.js         Range header parsing + range set math
  mime.js           Content types + media detection
  sources/mega.js   megajs-backed source (public links, range downloads)
  sources/demo.js   Offline demo source (generated video/audio/pattern)
  fixtures/         Tiny demo MP4 used by DEMO_MODE
public/             Zero-dependency frontend (custom video player)
test/smoke.mjs      End-to-end smoke test (demo mode)
```

## Limitations

- Only **public** links work (files, folders, and files inside folders — see table above).
  MEGA requires a login for everything else.
- Playback is limited to formats the browser can decode (MP4/H.264, WebM, OGG, MP3, WAV, FLAC,
  M4A, Opus…). Everything else is still downloadable.
- Folder listings show up to 1000 entries / 8 levels deep per request.
- The server needs outbound HTTPS access to `mega.nz` and MEGA's download servers.

## Disclaimer

MegaDirect is not affiliated with MEGA Limited. You are responsible for the content you download
and share — only use this tool for material you have the right to, and respect MEGA's
[Terms of Service](https://mega.nz/#terms).
