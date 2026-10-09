/**
 * Byte-range utilities. All ranges here are INCLUSIVE on both ends,
 * matching both HTTP `Range` semantics and MEGA's own offset syntax.
 */

/** Parse a single-range `Range` header against a known size. */
export function parseRange (header, size) {
  if (!header || typeof header !== 'string') return { type: 'none' }
  const m = /^bytes=(.*)$/i.exec(header.trim())
  if (!m) return { type: 'none' }
  const specs = m[1].split(',').map((s) => s.trim()).filter(Boolean)
  if (specs.length === 0) return { type: 'none' }
  // Multi-range: we serve the first range only (allowed by RFC 9110).
  const spec = specs[0]
  const rm = /^(?:\d+-\d*|-\d+)$/.exec(spec)
  if (!rm) return { type: 'unsatisfiable' }

  if (spec.startsWith('-')) {
    const suffix = Number(spec.slice(1))
    if (!Number.isFinite(suffix) || suffix <= 0) return { type: 'unsatisfiable' }
    if (size === 0) return { type: 'unsatisfiable' }
    const start = Math.max(0, size - suffix)
    return { type: 'range', start, end: size - 1 }
  }

  const [startStr, endStr] = spec.split('-')
  const start = Number(startStr)
  if (!Number.isFinite(start) || start >= size) return { type: 'unsatisfiable' }
  const end = endStr === '' ? size - 1 : Number(endStr)
  if (!Number.isFinite(end) || end < start) return { type: 'unsatisfiable' }
  return { type: 'range', start, end: Math.min(end, size - 1) }
}

/** Sorted, merged set of inclusive byte ranges. */
export class RangeSet {
  constructor (ranges = []) {
    this.ranges = []
    for (const [s, e] of ranges) this.add(s, e)
  }

  add (start, end) {
    if (end < start) return
    const merged = []
    let s = start
    let e = end
    for (const [rs, re] of this.ranges) {
      if (re + 1 < s) merged.push([rs, re])
      else if (e + 1 < rs) {
        merged.push([s, e])
        s = rs
        e = re
      } else {
        s = Math.min(s, rs)
        e = Math.max(e, re)
      }
    }
    merged.push([s, e])
    this.ranges = merged
  }

  has (start, end) {
    return this.ranges.some(([rs, re]) => rs <= start && end <= re)
  }

  /** How many contiguous bytes are cached starting at `pos` (0 if none). */
  availableFrom (pos) {
    for (const [rs, re] of this.ranges) {
      if (rs <= pos && pos <= re) return re - pos + 1
    }
    return 0
  }

  /** First sub-range of [start, end] not yet cached, or null when complete. */
  firstMissing (start, end) {
    let pos = start
    for (const [rs, re] of this.ranges) {
      if (re < pos) continue
      if (rs > pos) return { start: pos, end: Math.min(end, rs - 1) }
      // rs <= pos <= re
      if (re >= end) return null
      pos = re + 1
    }
    return pos <= end ? { start: pos, end } : null
  }

  get bytes () {
    return this.ranges.reduce((acc, [s, e]) => acc + (e - s + 1), 0)
  }

  get complete () {
    return this.ranges.length === 1 && this.ranges[0][0] === 0
  }

  toJSON () {
    return this.ranges
  }
}
