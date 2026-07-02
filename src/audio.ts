// Tiny audio engine: a looping background track plus synthesized win/lose
// cues (no extra asset files). The track only starts after a user gesture
// (browsers block autoplay), fades in, ducks on win/lose, and restarts on a
// new level.

let music: HTMLAudioElement | null = null
let ctx: AudioContext | null = null
let ramp = 0
let started = false

const MUSIC_VOL = 0.35
const DUCK_VOL = 0.08

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

export function initAudio(muted: boolean) {
  if (music || typeof window === "undefined") return
  music = new Audio("/beet.mp3")
  music.loop = true
  music.preload = "auto"
  music.volume = 0
  music.muted = muted
}

function rampTo(to: number, durMs: number) {
  if (!music) return
  cancelAnimationFrame(ramp)
  const from = music.volume
  const t0 = performance.now()
  const step = (now: number) => {
    if (!music) return
    const k = Math.min(1, Math.max(0, now - t0) / durMs)
    music.volume = clamp01(from + (to - from) * k)
    if (k < 1) ramp = requestAnimationFrame(step)
  }
  ramp = requestAnimationFrame(step)
}

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (AC) ctx = new AC()
  }
  if (ctx && ctx.state === "suspended") void ctx.resume()
  return ctx
}

/** Start the track (call from a user gesture). Idempotent. */
export function startMusic(muted: boolean) {
  if (!music || started) return
  started = true
  music.muted = muted
  ensureCtx()
  music
    .play()
    .then(() => rampTo(MUSIC_VOL, 2500))
    .catch(() => {
      started = false // still blocked; a later gesture will retry
    })
}

export function setMusicMuted(muted: boolean) {
  if (music) music.muted = muted
}

/** Dip the music (win/lose moment). */
export function duckMusic() {
  rampTo(DUCK_VOL, 250)
}

/** Bring the music back up (e.g. returning to idle after a loss). */
export function restoreMusic() {
  rampTo(MUSIC_VOL, 700)
}

/** Restart the track from the top for a fresh level. */
export function restartMusic() {
  if (!music || music.paused) return
  try {
    music.currentTime = 0
  } catch {
    /* seeking may fail before metadata loads; ignore */
  }
  music.volume = 0
  rampTo(MUSIC_VOL, 2000)
}

function blip(
  c: AudioContext,
  type: OscillatorType,
  freq: number,
  at: number,
  dur: number,
  peak: number,
  glideTo?: number,
) {
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, at)
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur)
  g.gain.setValueAtTime(0, at)
  g.gain.linearRampToValueAtTime(peak, at + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0008, at + dur)
  o.connect(g).connect(c.destination)
  o.start(at)
  o.stop(at + dur + 0.05)
}

/** Bright ascending arpeggio. */
export function playWin(muted: boolean) {
  if (muted) return
  const c = ensureCtx()
  if (!c) return
  const t = c.currentTime + 0.01
  const notes = [523.25, 659.25, 783.99, 1046.5] // C5 E5 G5 C6
  notes.forEach((f, i) => blip(c, "triangle", f, t + i * 0.085, 0.5, 0.2))
}

/** Gentle soft descending sigh — deliberately not abrasive. */
export function playLose(muted: boolean) {
  if (muted) return
  const c = ensureCtx()
  if (!c) return
  const t = c.currentTime + 0.01
  blip(c, "sine", 293.66, t, 0.7, 0.13, 220.0) // D4 gliding down to A3
  blip(c, "sine", 220.0, t + 0.16, 0.85, 0.09) // soft low A3 underneath
}
