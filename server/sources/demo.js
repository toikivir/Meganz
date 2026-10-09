/**
 * Offline demo source — used when DEMO_MODE=1 so the whole product can be
 * exercised without talking to MEGA (also handy for automated tests).
 */

import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { config } from '../config.js'
import { FillError } from '../cache.js'
import { encodeToken } from '../links.js'

const FIXTURE = path.join(config.root, 'server', 'fixtures', 'demo-video.mp4')
const DEMO_FILE_SIZE = 24 * 1024 * 1024
const DEMO_AUDIO_SECONDS = 60
const DEMO_AUDIO_RATE = 44100

let wavBuffer = null

function buildWav () {
  if (wavBuffer) return wavBuffer
  const frames = DEMO_AUDIO_SECONDS * DEMO_AUDIO_RATE
  const bytes = frames * 4 // 16-bit stereo
  const buf = Buffer.alloc(44 + bytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + bytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(2, 22) // channels
  buf.writeUInt32LE(DEMO_AUDIO_RATE, 24)
  buf.writeUInt32LE(DEMO_AUDIO_RATE * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(bytes, 40)

  // Gentle pentatonic melody over a bass drone — good for listening to seeks.
  const scale = [220, 246.94, 277.18, 329.63, 369.99, 440]
  for (let i = 0; i < frames; i++) {
    const t = i / DEMO_AUDIO_RATE
    const note = scale[Math.floor(t * 2) % scale.length]
    const env = Math.min(1, (t % 0.5) * 8) * Math.exp(-(t % 0.5) * 3)
    const l = Math.sin(2 * Math.PI * note * t) * 0.35 * env +
      Math.sin(2 * Math.PI * (note / 2) * t) * 0.22 +
      Math.sin(2 * Math.PI * 55 * t) * 0.12
    const r = Math.sin(2 * Math.PI * note * 1.005 * t) * 0.35 * env +
      Math.sin(2 * Math.PI * (note / 2) * t) * 0.22 +
      Math.sin(2 * Math.PI * 55 * t) * 0.12
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(l * 32767))), 44 + i * 4)
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(r * 32767))), 44 + i * 4 + 2)
  }
  wavBuffer = buf
  return buf
}

function patternChunk (absStart, length) {
  const buf = Buffer.allocUnsafe(length)
  const tail = Buffer.alloc(4)
  for (let i = 0; i < length; i += 4) {
    let x = (((absStart + i) >>> 2) + 0x9e3779b9) >>> 0
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    if (i + 4 <= length) {
      buf.writeUInt32LE(x, i)
    } else {
      tail.writeUInt32LE(x, 0)
      tail.copy(buf, i)
    }
  }
  return buf
}

function patternStream (start, end) {
  const total = end - start + 1
  async function * generate () {
    let pos = 0
    while (pos < total) {
      const len = Math.min(64 * 1024, total - pos)
      yield patternChunk(start + pos, len)
      pos += len
    }
  }
  return Readable.from(generate())
}

const KINDS = {
  video: { name: 'MegaDirect-demo-plasma.mp4', size: () => fs.statSync(FIXTURE).size },
  audio: { name: 'demo-soundtrack.wav', size: () => buildWav().length },
  file: { name: 'demo-archive.bin', size: () => DEMO_FILE_SIZE },
  // A file that "lives inside" the demo folder — exercises the
  // "Browse folder" button on file cards (parent-folder navigation).
  'folder-file': { name: 'inside-a-folder-clip.mp4', size: () => fs.statSync(FIXTURE).size }
}

function demoFolderTree () {
  const videoSize = KINDS.video.size()
  const audioSize = KINDS.audio.size()
  return {
    name: 'MegaDirect Demo Folder',
    truncated: false,
    entries: [
      {
        type: 'file',
        name: KINDS.video.name,
        size: videoSize,
        modified: Date.now(),
        token: encodeToken({ demo: 'video' })
      },
      {
        type: 'file',
        name: KINDS.audio.name,
        size: audioSize,
        modified: Date.now(),
        token: encodeToken({ demo: 'audio' })
      },
      {
        type: 'file',
        name: KINDS.file.name,
        size: DEMO_FILE_SIZE,
        modified: Date.now(),
        token: encodeToken({ demo: 'file' })
      },
      {
        type: 'folder',
        name: 'bonus',
        children: [
          {
            type: 'file',
            name: 'bonus-tone.wav',
            size: audioSize,
            modified: Date.now(),
            token: encodeToken({ demo: 'audio', name: 'bonus-tone.wav' })
          },
          {
            type: 'file',
            name: KINDS['folder-file'].name,
            size: KINDS['folder-file'].size(),
            modified: Date.now(),
            token: encodeToken({ demo: 'folder-file' })
          },
          {
            type: 'folder',
            name: 'deep',
            children: [
              {
                type: 'file',
                name: 'deep-clip.mp4',
                size: videoSize,
                modified: Date.now(),
                token: encodeToken({ demo: 'video', name: 'deep-clip.mp4' })
              }
            ]
          }
        ]
      }
    ]
  }
}

export function createDemoSource (descriptor) {
  const kind = descriptor.demo
  const meta = KINDS[kind]

  return {
    kind: 'demo',

    async resolve () {
      if (kind === 'folder') {
        throw new FillError('This link points at a folder — browse it to pick files.', {
          code: 'IS_FOLDER',
          status: 400
        })
      }
      return {
        name: (descriptor.name && String(descriptor.name)) || meta.name,
        size: meta.size()
      }
    },

    async list () {
      if (kind !== 'folder') {
        throw new FillError('This link is a single file, not a folder.', { code: 'NOT_FOLDER', status: 400 })
      }
      return demoFolderTree()
    },

    async openRange (start, end) {
      if (kind === 'video' || kind === 'folder-file') {
        return fs.createReadStream(FIXTURE, { start, end })
      }
      if (kind === 'audio') {
        return Readable.from([buildWav().subarray(start, end + 1)])
      }
      return patternStream(start, end)
    }
  }
}
