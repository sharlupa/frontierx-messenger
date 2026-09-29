import type { Conversation } from "../lib/types"
import { useSettings } from "../state/settings"
import { IconBookmark, IconPin, IconBellOff } from "./Icons"

const AVATAR_COLORS = ["#e17076", "#7bc862", "#65aadd", "#a695e7", "#ee7aae", "#6ec9cb", "#f2a45c"]

function avatarColor(seed: string): string {
	let hash = 0
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
	return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

function initials(label: string): string {
	const parts = label.trim().split(/\s+/).filter(Boolean)
	if (parts.length === 0) return "?"
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
	return (parts[0][0] + parts[1][0]).toUpperCase()
}

export function ConversationList({
	conversations,
	activeId,
	unread,
	onSelect,
	pinnedIds,
	mentionIds,
	onlinePeerIds,
	emptyLabel,
}: {
	conversations: Conversation[]
	activeId: string | null
	unread: Record<string, number>
	onSelect: (id: string) => void
	pinnedIds?: Set<string>
	mentionIds?: string[]
	onlinePeerIds?: string[]
	emptyLabel?: string
}) {
	const { t } = useSettings()
	const labelFor = (conversation: Conversation): string => {
		if (conversation.isSelf) return t("savedMessages")
		if (conversation.kind === "direct" && conversation.peer) return conversation.peer.displayName || conversation.peer.username
		if (conversation.title) return conversation.title
		if (conversation.kind === "direct") return t("directConversation")
		return conversation.kind === "channel" ? t("kindChannel") : t("kindGroup")
	}
	const kindLabel = (conversation: Conversation): string => {
		if (conversation.isSelf) return t("savedMessages")
		if (conversation.kind === "channel") return t("kindChannel")
		if (conversation.kind === "group") return t("kindGroup")
		if (conversation.peer?.isBot) return t("kindBot")
		return t("kindDirect")
	}
	if (conversations.length === 0) {
		return (
			<div className="conv-list">
				<div className="conv-item-sub conv-empty">{emptyLabel ?? t("noChatsYet")}</div>
			</div>
		)
	}
	const now = Date.now()
	return (
		<div className="conv-list">
			{conversations.map((conversation) => {
				const count = unread[conversation.id] ?? 0
				const label = labelFor(conversation)
				const pinned = pinnedIds ? pinnedIds.has(conversation.id) : false
				const muted = Boolean(conversation.mutedUntil && Date.parse(conversation.mutedUntil) > now)
				const peerAvatar = conversation.kind === "direct" && conversation.peer ? conversation.peer.avatar : null
				const avatarSrc = conversation.avatar || peerAvatar
				const avatarSeed = conversation.kind === "direct" && conversation.peer ? conversation.peer.id : conversation.id
				const avatarStyle = { backgroundColor: avatarColor(avatarSeed) }
				// Groups and channels wear an M3 shape instead of a circle.
				const shapeClass = conversation.kind === "group" ? " shape-group" : conversation.kind === "channel" ? " shape-channel" : ""
				const peerOnline = conversation.kind === "direct" && conversation.peer ? Boolean(onlinePeerIds && onlinePeerIds.includes(conversation.peer.id)) : false
				return (
					<button
						key={conversation.id}
						className={"conv-item" + (conversation.id === activeId ? " active" : "")}
						onClick={() => onSelect(conversation.id)}
					>
						<span className="conv-avatar-wrap">
						{avatarSrc ? (
							<img className={"conv-avatar conv-avatar-img" + shapeClass} src={avatarSrc} alt={label} />
						) : conversation.isSelf ? (
							<div className="conv-avatar conv-avatar-self" aria-hidden="true"><IconBookmark size={18} /></div>
						) : (
							<div className={"conv-avatar" + shapeClass} style={avatarStyle}>{initials(label)}</div>
						)}
						{peerOnline ? <span className="presence-dot online" aria-hidden="true" /> : null}
						</span>
						<div className="conv-item-main">
							<div className="conv-item-title">
								<span className="conv-item-title-text">{label}</span>
								{pinned ? <span className="conv-pin" aria-hidden="true"><IconPin size={13} /></span> : null}
								{muted ? <span className="conv-mute" aria-hidden="true"><IconBellOff size={13} /></span> : null}
							</div>
							<div className="conv-item-sub">{kindLabel(conversation)}</div>
						</div>
						{mentionIds && mentionIds.includes(conversation.id) ? <div className="conv-mention" title={t("mentionedYou")} aria-label={t("mentionedYou")}>@</div> : null}
						{count > 0 ? <div className="conv-badge">{count}</div> : null}
					</button>
				)
			})}
		</div>
	)
}
