import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dirname, '..')

const num = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const GB = 1024 ** 3
const MB = 1024 ** 2

export const config = {
  root,
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',

  // Disk cache: every byte pulled from MEGA is stored so each file is
  // fetched at most once — visitors never run into transfer quotas.
  cacheDir: process.env.CACHE_DIR || path.join(root, '.cache'),
  cacheMaxBytes: num(process.env.CACHE_MAX_GB, 20) * GB,

  // Refuse absurdly large files outright.
  maxFileBytes: num(process.env.MAX_FILE_GB, 50) * GB,

  // Background prefetch: keep downloading after the user stops watching so
  // the next visitor gets a fully cached file. Files larger than this are
  // only cached as far as they were actually requested.
  prefetch: process.env.PREFETCH !== '0',
  prefetchMaxBytes: num(process.env.PREFETCH_MAX_GB, 4) * GB,

  // One MEGA fetch stream per file at a time (segments of SEGMENT_MB),
  // parallel connections *within* that stream.
  segmentBytes: num(process.env.SEGMENT_MB, 8) * MB,
  megaConnections: num(process.env.MEGA_CONNECTIONS, 4),

  demoMode: process.env.DEMO_MODE === '1',
  trustProxy: process.env.TRUST_PROXY === '1'
}
