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

function playRing(audio: AudioContext): void {
  const base = audio.currentTime
  for (const offset of [0, 0.4]) {
    const start = base + offset
    const gain = audio.createGain()
    gain.connect(audio.destination)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.26, start + 0.04)
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

let ringTimer: ReturnType<typeof setInterval> | null = null

export function startRingtone(): void {
  const audio = getCtx()
  if (!audio) return
  stopRingtone()
  const ring = () => {
    if (audio.state === "suspended") {
      void audio.resume().then(() => playRing(audio)).catch(() => undefined)
    } else {
      playRing(audio)
    }
  }
  ring()
  ringTimer = setInterval(ring, 2600)
}

export function stopRingtone(): void {
  if (ringTimer) {
    clearInterval(ringTimer)
    ringTimer = null
  }
}
