import { useEffect, useRef, useState } from "react"
import { connectRealtime, type RealtimeHandle } from "./ws"
import type { StoredAccount } from "./session"

// The other signed-in accounts on this device stay connected quietly (they
// never appear online) so their new messages show up as a badge on the
// account switcher. Message text stays sealed: only the arrival is counted.
export function useBackgroundAccounts(accounts: StoredAccount[], activeId: string | null, onMessage?: (account: StoredAccount) => void): Record<string, number> {
	const [unread, setUnread] = useState<Record<string, number>>({})
	const onMessageRef = useRef(onMessage)
	onMessageRef.current = onMessage
	const key = accounts
		.filter((account) => account.token && account.id !== activeId)
		.map((account) => account.id + ":" + account.token)
		.join(",")

	useEffect(() => {
		const handles: RealtimeHandle[] = []
		for (const account of accounts) {
			if (!account.token || account.id === activeId) continue
			const handle = connectRealtime(
				account.token,
				(event) => {
					if (event.type !== "message.created") return
					if (event.message.senderId === account.id) return
					setUnread((prev) => ({ ...prev, [account.id]: (prev[account.id] ?? 0) + 1 }))
					if (!event.message.silent && onMessageRef.current) onMessageRef.current(account)
				},
				{ quiet: true },
			)
			handles.push(handle)
		}
		return () => {
			for (const handle of handles) handle.close()
		}
	}, [key])

	return unread
}
