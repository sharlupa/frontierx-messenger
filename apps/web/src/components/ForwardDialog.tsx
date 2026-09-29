import { useState } from "react"
import type { Conversation } from "../lib/types"
import { useSettings } from "../state/settings"
import { Avatar, ListGroup, ListItem, Sheet, TextField } from "./m3"
import { IForwardArrow } from "./ForwardIcon"

// Picking the chat a message goes to. The list reads like the chat list:
// avatar, name, kind; a search narrows it down.
export function ForwardDialog({
	conversations,
	onClose,
	onForward,
	titleOf,
}: {
	conversations: Conversation[]
	onClose: () => void
	onForward: (conversationId: string) => void | Promise<void>
	titleOf?: (conversation: Conversation) => string
}) {
	const { t } = useSettings()
	const [busyId, setBusyId] = useState<string | null>(null)
	const [query, setQuery] = useState("")
	const label = (conversation: Conversation): string => {
		if (titleOf) return titleOf(conversation)
		if (conversation.isSelf) return t("savedMessages")
		if (conversation.kind === "direct" && conversation.peer) return conversation.peer.displayName || conversation.peer.username
		if (conversation.title) return conversation.title
		return conversation.kind === "channel" ? t("kindChannel") : conversation.kind === "group" ? t("kindGroup") : t("kindDirect")
	}
	const kindLabel = (conversation: Conversation): string =>
		conversation.isSelf ? t("savedMessages") : conversation.kind === "channel" ? t("kindChannel") : conversation.kind === "group" ? t("kindGroup") : conversation.peer ? "@" + conversation.peer.username : t("kindDirect")
	const term = query.trim().toLocaleLowerCase()
	const list = conversations.filter((conversation) => !conversation.archivedAt || term).filter((conversation) => label(conversation).toLocaleLowerCase().includes(term))
	return (
		<Sheet title={t("forwardTo")} icon={<IForwardArrow />} iconShape="pill" iconTone="blue" onClose={onClose} size="md">
			<TextField label={t("searchChats")} type="search" value={query} onChange={setQuery} autoFocus />
			{list.length === 0 ? (
				<p className="settings-intro">{t("forwardEmpty")}</p>
			) : (
				<ListGroup>
					{list.map((conversation) => (
						<ListItem
							key={conversation.id}
							leading={<Avatar src={conversation.avatar || conversation.peer?.avatar} label={label(conversation)} seed={conversation.peer?.id ?? conversation.id} size={40} shape={conversation.kind === "group" ? "group" : conversation.kind === "channel" ? "channel" : "circle"} />}
							title={label(conversation)}
							subtitle={kindLabel(conversation)}
							disabled={busyId !== null}
							onClick={() => {
								setBusyId(conversation.id)
								void Promise.resolve(onForward(conversation.id)).finally(() => setBusyId(null))
							}}
						/>
					))}
				</ListGroup>
			)}
		</Sheet>
	)
}
