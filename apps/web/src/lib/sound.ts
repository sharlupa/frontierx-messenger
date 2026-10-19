let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  try {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const Ctor = w.AudioContext || w.webkitAudioContext
    if (!Ctor) return null
    if (!ctx) ctx = new Ctor()
    return ctx
  } catch {
    return null
  }
}

function playBeep(audio: AudioContext): void {
  const now = audio.currentTime
  const gain = audio.createGain()
  gain.connect(audio.destination)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.32, now + 0.03)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45)
  const osc = audio.createOscillator()
  osc.type = "sine"
  osc.frequency.setValueAtTime(620, now)
  osc.frequency.setValueAtTime(880, now + 0.12)
  osc.connect(gain)
  osc.start(now)
  osc.stop(now + 0.48)
}

const SOUND_KEY = "fx.sound"

// Message sounds can be switched off in the notification settings.
export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off"
  } catch {
    return true
  }
}

export function setSoundEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(SOUND_KEY)
    else localStorage.setItem(SOUND_KEY, "off")
  } catch {
    // the choice lasts for this page
  }
}

export function playMessageSound(): void {
  if (!soundEnabled()) return
  const audio = getCtx()
  if (!audio) return
  try {
    if (audio.state === "suspended") {
      void audio.resume().then(() => playBeep(audio)).catch(() => undefined)
    } else {
      playBeep(audio)
    }
  } catch {
    /* ignore */
  }
}

// Browsers keep the AudioContext suspended until the user interacts with the
// page. Warm it up on the first gesture so the very first incoming message is
// actually audible instead of only lighting the tab's audio icon.
function warmUp(): void {
  const audio = getCtx()
  if (audio && audio.state === "suspended") void audio.resume().catch(() => undefined)
}

if (typeof window !== "undefined") {
  const opts: AddEventListenerOptions = { passive: true }
  window.addEventListener("pointerdown", warmUp, opts)
  window.addEventListener("keydown", warmUp, opts)
  window.addEventListener("touchstart", warmUp, opts)
}

export function ensureAudioContext(): AudioContext | null {
  const audio = getCtx()
  if (audio && audio.state === "suspended") void audio.resume().catch(() => undefined)
  return audio
}

// Call sounds have to be heard over the call itself and from a phone lying
// on the table, so they are louder than the message beep.
const RING_VOLUME = 0.5
const CALL_NOTE_VOLUME = 0.4
const RINGBACK_VOLUME = 0.35

function playRing(audio: AudioContext): void {
  const base = audio.currentTime
  for (const offset of [0, 0.4]) {
    const start = base + offset
    const gain = audio.createGain()
    gain.connect(audio.destination)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(RING_VOLUME, start + 0.04)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32)
    const osc = audio.createOscillator()
    osc.type = "sine"
    osc.frequency.setValueAtTime(523.25, start)
    osc.frequency.setValueAtTime(659.25, start + 0.16)
    osc.connect(gain)
    osc.start(start)
    osc.stop(start + 0.34)
  }
}

// Someone came into the call you are in (two short notes going up) or left
// it (the same notes going down). They belong to the call, like the ringtone,
// so the message sound switch does not silence them.
const CALL_NOTES = [587.33, 880]
const CALL_NOTE_SECONDS = 0.14

function playNotes(audio: AudioContext, notes: number[]): void {
  const base = audio.currentTime
  notes.forEach((frequency, index) => {
    const start = base + index * CALL_NOTE_SECONDS
    const gain = audio.createGain()
    gain.connect(audio.destination)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(CALL_NOTE_VOLUME, start + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + CALL_NOTE_SECONDS + 0.08)
    const osc = audio.createOscillator()
    osc.type = "sine"
    osc.frequency.setValueAtTime(frequency, start)
    osc.connect(gain)
    osc.start(start)
    osc.stop(start + CALL_NOTE_SECONDS + 0.1)
  })
}

function withAudio(play: (audio: AudioContext) => void): void {
  const audio = getCtx()
  if (!audio) return
  try {
    if (audio.state === "suspended") {
      void audio.resume().then(() => play(audio)).catch(() => undefined)
    } else {
      play(audio)
    }
  } catch {
    /* ignore */
  }
}

export function playCallJoinSound(): void {
  withAudio((audio) => playNotes(audio, CALL_NOTES))
}

export function playCallLeaveSound(): void {
  withAudio((audio) => playNotes(audio, CALL_NOTES.slice().reverse()))
}

// Calling out, until someone answers: a long low tone every few seconds, as
// on a phone line (425 Hz, the usual ringback tone).
const RINGBACK_HZ = 425
const RINGBACK_TONE_SECONDS = 1
const RINGBACK_EVERY_MS = 4000

function playRingback(audio: AudioContext): void {
  const start = audio.currentTime
  const gain = audio.createGain()
  gain.connect(audio.destination)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(RINGBACK_VOLUME, start + 0.05)
  gain.gain.setValueAtTime(RINGBACK_VOLUME, start + RINGBACK_TONE_SECONDS - 0.08)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + RINGBACK_TONE_SECONDS)
  const osc = audio.createOscillator()
  osc.type = "sine"
  osc.frequency.setValueAtTime(RINGBACK_HZ, start)
  osc.connect(gain)
  osc.start(start)
  osc.stop(start + RINGBACK_TONE_SECONDS + 0.02)
}

let ringbackTimer: ReturnType<typeof setInterval> | null = null

export function startRingback(): void {
  stopRingback()
  withAudio(playRingback)
  ringbackTimer = setInterval(() => withAudio(playRingback), RINGBACK_EVERY_MS)
}

export function stopRingback(): void {
  if (ringbackTimer) {
    clearInterval(ringbackTimer)
    ringbackTimer = null
  }
}

let ringTimer: ReturnType<typeof setInterval> | null = null

export function startRingtone(): void {
  stopRingtone()
  withAudio(playRing)
  ringTimer = setInterval(() => withAudio(playRing), 2600)
}

export function stopRingtone(): void {
  if (ringTimer) {
    clearInterval(ringTimer)
    ringTimer = null
  }
}
