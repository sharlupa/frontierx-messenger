export interface Clock {
  now(): Date
  nowMs(): number
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }
  nowMs(): number {
    return Date.now()
  }
}

/**
 * A clock the tests control explicitly. The file-lifecycle timers use a Clock,
 * so day-20 and day-25 behavior can be verified deterministically with no real
 * waiting.
 */
export class ManualClock implements Clock {
  private t: number
  constructor(start: Date | number = 0) {
    this.t = typeof start === "number" ? start : start.getTime()
  }
  now(): Date {
    return new Date(this.t)
  }
  nowMs(): number {
    return this.t
  }
  advanceMs(ms: number): void {
    this.t += ms
  }
  advanceDays(days: number): void {
    this.t += days * 24 * 60 * 60 * 1000
  }
  set(date: Date | number): void {
    this.t = typeof date === "number" ? date : date.getTime()
  }
}
