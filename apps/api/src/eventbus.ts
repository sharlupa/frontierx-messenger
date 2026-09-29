import type { WsEvent } from "@frontierx/protocol"

// In-process pub/sub keyed by user id. A WebSocket connection subscribes for its
// authenticated user; route handlers publish an event to every member of the
// affected conversation. This is the first-stage transport; the same interface
// is backed by Redis pub/sub in staging (see docs/ARCHITECTURE.md).
export type EventSubscriber = (event: WsEvent) => void
export type PresenceListener = (userId: string, online: boolean) => void
export type DisconnectListener = (userId: string) => void
// Unsubscribes; setPresence marks the connection as present (the person is
// looking at the app) or away (tab or app in the background) without a
// reconnect.
export type Subscription = (() => void) & { setPresence: (active: boolean) => void }

export class EventBus {
  private byUser = new Map<string, Set<EventSubscriber>>()
  private presenceListener: PresenceListener | null = null
  private disconnectListener: DisconnectListener | null = null
  private quiet = new WeakSet<EventSubscriber>()

  isUserVisible(userId: string): boolean {
    const set = this.byUser.get(userId)
    if (!set) return false
    for (const sub of set) if (!this.quiet.has(sub)) return true
    return false
  }

  // Presence is deliberately derived from live authenticated WebSocket
  // subscriptions. It is not persisted, so a process restart correctly makes
  // every user offline until their client reconnects.
  setPresenceListener(listener: PresenceListener): void {
    this.presenceListener = listener
  }

  // Everyone with at least one presence-reporting connection.
  visibleUserIds(): string[] {
    const out: string[] = []
    for (const userId of this.byUser.keys()) if (this.isUserVisible(userId)) out.push(userId)
    return out
  }

  // Called when a user's last connection closes (not when they merely step
  // away): the moment to end their calls.
  setDisconnectListener(listener: DisconnectListener): void {
    this.disconnectListener = listener
  }

  isUserOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0
  }

  private notifyPresence(userId: string, online: boolean): void {
    try {
      this.presenceListener?.(userId, online)
    } catch {
      // Presence fan-out must never prevent a valid socket from subscribing or
      // disconnecting. The next connection-state transition can repair UI
      // state through the membership-scoped snapshot endpoint.
    }
  }

  subscribeUser(userId: string, sub: EventSubscriber, options?: { presence?: boolean }): Subscription {
    if (options?.presence === false) this.quiet.add(sub)
    let set = this.byUser.get(userId)
    const wasOnline = this.isUserVisible(userId)
    if (!set) {
      set = new Set()
      this.byUser.set(userId, set)
    }
    set.add(sub)
    if (!wasOnline && this.isUserVisible(userId)) this.notifyPresence(userId, true)

    let subscribed = true
    const unsubscribe = () => {
      if (!subscribed) return
      subscribed = false
      const current = this.byUser.get(userId)
      if (!current) return
      const wasVisible = this.isUserVisible(userId)
      current.delete(sub)
      if (current.size === 0) this.byUser.delete(userId)
      if (wasVisible && !this.isUserVisible(userId)) this.notifyPresence(userId, false)
      if (!this.byUser.has(userId)) this.notifyDisconnect(userId)
    }
    const setPresence = (active: boolean) => {
      if (!subscribed) return
      const wasVisible = this.isUserVisible(userId)
      if (active) this.quiet.delete(sub)
      else this.quiet.add(sub)
      const visible = this.isUserVisible(userId)
      if (wasVisible !== visible) this.notifyPresence(userId, visible)
    }
    return Object.assign(unsubscribe, { setPresence })
  }

  private notifyDisconnect(userId: string): void {
    try {
      this.disconnectListener?.(userId)
    } catch {
      // Same rule as presence: cleanup must never break a disconnect.
    }
  }

  publishToUsers(userIds: Iterable<string>, event: WsEvent): void {
    const seen = new Set<string>()
    for (const userId of userIds) {
      if (seen.has(userId)) continue
      seen.add(userId)
      const set = this.byUser.get(userId)
      if (!set) continue
      for (const sub of set) {
        try {
          sub(event)
        } catch {
          // A misbehaving subscriber must not break delivery to others.
        }
      }
    }
  }

  subscriberCount(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0
  }
}
