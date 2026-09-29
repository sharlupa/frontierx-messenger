import { useEffect, useRef, useState } from "react"
import type { Conversation, Friend, FriendRequest, UserSummary } from "../lib/types"
import { api } from "../lib/api"
import { useAuth } from "../state/auth"
import { useSettings } from "../state/settings"
import { errorText } from "../lib/errorText"
import { Avatar, Banner, Button, IconButton, ListGroup, ListItem, Sheet, TextField } from "./m3"
import { IAdd, IBot, ICheck, IClose, IPeople, ITrash } from "./m3icons"

function requestName(request: FriendRequest): string {
	return request.displayName || request.username || request.fromUser
}

export function FriendRequestsDialog({
	onClose,
	onFriendAccepted,
}: {
	onClose: () => void
	onFriendAccepted: (conversation: Conversation) => void
}) {
	const { t } = useSettings()
	const { user } = useAuth()
	const [incoming, setIncoming] = useState<FriendRequest[]>([])
	const [outgoing, setOutgoing] = useState<FriendRequest[]>([])
	const [friends, setFriends] = useState<Friend[]>([])
	const [username, setUsername] = useState("")
	const [suggestions, setSuggestions] = useState<UserSummary[]>([])
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const searchSeq = useRef(0)

	async function refresh() {
		try {
			const [reqs, fr] = await Promise.all([api.listFriendRequests(), api.listFriends()])
			setIncoming(reqs.incoming)
			setOutgoing(reqs.outgoing)
			setFriends(fr.friends)
		} catch (err) {
			setError(errorText(err, t("friendActionFailed")))
		}
	}

	useEffect(() => {
		void refresh()
	}, [])

	useEffect(() => {
		const value = username.trim()
		if (value.length < 2) {
			setSuggestions([])
			return
		}
		const seq = ++searchSeq.current
		const handle = window.setTimeout(() => {
			void (async () => {
				try {
					const res = await api.searchUsers(value)
					if (seq !== searchSeq.current) return
					const friendIds = new Set(friends.map((f) => f.id))
					setSuggestions(res.users.filter((u) => u.id !== (user ? user.id : "") && !friendIds.has(u.id)))
				} catch {
					if (seq === searchSeq.current) setSuggestions([])
				}
			})()
		}, 220)
		return () => window.clearTimeout(handle)
	}, [username, friends, user])

	async function send(value: string) {
		const name = value.trim()
		if (!name || busy) return
		setBusy(true)
		setError(null)
		try {
			const res = await api.sendFriendRequest(name)
			setUsername("")
			setSuggestions([])
			if (res.status === "accepted" && res.conversation) onFriendAccepted(res.conversation)
			await refresh()
		} catch (err) {
			setError(errorText(err, t("friendActionFailed")))
		} finally {
			setBusy(false)
		}
	}

	async function accept(request: FriendRequest) {
		setBusy(true)
		setError(null)
		try {
			const res = await api.acceptFriendRequest(request.id)
			onFriendAccepted(res.conversation)
			await refresh()
		} catch (err) {
			setError(errorText(err, t("friendActionFailed")))
		} finally {
			setBusy(false)
		}
	}

	async function decline(request: FriendRequest) {
		setBusy(true)
		setError(null)
		try {
			await api.declineFriendRequest(request.id)
			await refresh()
		} catch (err) {
			setError(errorText(err, t("friendActionFailed")))
		} finally {
			setBusy(false)
		}
	}

	async function remove(friend: Friend) {
		setBusy(true)
		setError(null)
		try {
			await api.removeFriend(friend.id)
			await refresh()
		} catch (err) {
			setError(errorText(err, t("friendActionFailed")))
		} finally {
			setBusy(false)
		}
	}

	return (
		<Sheet title={t("friendRequests")} icon={<IPeople />} iconShape="clover" iconTone="green" onClose={onClose} size="md">
			<div className="friend-add">
				<TextField
					label={t("typeUsername")}
					value={username}
					disabled={busy}
					onChange={setUsername}
					onEnter={() => void send(username)}
					autoFocus
					trailing={<Button variant="filled" icon={<IAdd size={18} />} busy={busy} disabled={username.trim() === ""} onClick={() => void send(username)}>{t("sendRequest")}</Button>}
				/>
				{suggestions.length > 0 ? (
					<ListGroup>
						{suggestions.map((item) => (
							<ListItem
								key={item.id}
								leading={<Avatar src={item.avatar} label={item.displayName || item.username} seed={item.id} size={36} />}
								title={<>{item.displayName || item.username}{item.isBot ? <span className="bot-badge"><IBot size={11} /> BOT</span> : null}</>}
								subtitle={"@" + item.username}
								disabled={busy}
								onClick={() => void send(item.username)}
								trailing={<IAdd size={18} />}
							/>
						))}
					</ListGroup>
				) : null}
			</div>
			{error ? <Banner tone="error">{error}</Banner> : null}
			{incoming.length > 0 ? (
				<ListGroup label={t("incomingRequests") + " · " + String(incoming.length)}>
					{incoming.map((request) => (
						<ListItem
							key={request.id}
							leading={<Avatar src={request.avatar} label={requestName(request)} seed={request.fromUser} size={40} />}
							title={requestName(request)}
							subtitle={request.username ? "@" + request.username : undefined}
							trailing={
								<span className="m3-row">
									<IconButton label={t("decline")} disabled={busy} onClick={() => void decline(request)}><IClose /></IconButton>
									<IconButton label={t("accept")} variant="filled" disabled={busy} onClick={() => void accept(request)}><ICheck /></IconButton>
								</span>
							}
						/>
					))}
				</ListGroup>
			) : null}
			{outgoing.length > 0 ? (
				<ListGroup label={t("outgoingRequests")}>
					{outgoing.map((request) => (
						<ListItem key={request.id} leading={<Avatar src={request.avatar} label={requestName(request)} seed={request.toUser} size={40} />} title={requestName(request)} subtitle={t("pendingRequest")} />
					))}
				</ListGroup>
			) : null}
			<ListGroup label={t("friends") + " · " + String(friends.length)}>
				{friends.length === 0 ? <ListItem title={t("noFriends")} /> : null}
				{friends.map((friend) => (
					<ListItem
						key={friend.id}
						leading={<Avatar src={friend.avatar} label={friend.displayName || friend.username} seed={friend.id} size={40} />}
						title={friend.displayName || friend.username}
						subtitle={"@" + friend.username}
						trailing={<IconButton label={t("removeFriend")} disabled={busy} onClick={() => void remove(friend)}><ITrash /></IconButton>}
					/>
				))}
			</ListGroup>
		</Sheet>
	)
}
