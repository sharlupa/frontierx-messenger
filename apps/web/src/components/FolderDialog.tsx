import { useState } from "react"
import { api } from "../lib/api"
import type { Conversation, ConversationFolder } from "../lib/types"
import { useSettings } from "../state/settings"
import { Avatar, Banner, Button, Chip, ListGroup, ListItem, Sheet, Switch, TextField } from "./m3"
import { IAdd, IGallery, ITrash } from "./m3icons"

export const FOLDER_NAME_MAX = 48

export function FolderDialog({
	folders,
	conversations,
	conversationLabel,
	onClose,
	onChanged,
}: {
	folders: ConversationFolder[]
	conversations: Conversation[]
	conversationLabel: (conversation: Conversation) => string
	onClose: () => void
	onChanged: () => Promise<void> | void
}) {
	const { t } = useSettings()
	const [name, setName] = useState("")
	const [selectedId, setSelectedId] = useState<string | null>(folders.length > 0 ? folders[0].id : null)
	const [query, setQuery] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const selected = folders.find((folder) => folder.id === selectedId) ?? null

	async function run(action: () => Promise<unknown>) {
		setBusy(true)
		setError(null)
		try {
			await action()
			await onChanged()
		} catch {
			setError(t("folderActionFailed"))
		} finally {
			setBusy(false)
		}
	}

	async function createFolder() {
		const trimmed = name.trim()
		if (!trimmed || busy) return
		await run(async () => {
			const created = await api.createConversationFolder(trimmed.slice(0, FOLDER_NAME_MAX))
			setName("")
			setSelectedId(created.folder.id)
		})
	}

	async function removeFolder(folder: ConversationFolder) {
		if (busy) return
		await run(async () => {
			await api.deleteConversationFolder(folder.id)
			if (selectedId === folder.id) setSelectedId(null)
		})
	}

	async function toggleChat(conversationId: string, active: boolean) {
		if (!selected || busy) return
		await run(() => api.setFolderConversation(selected.id, conversationId, active))
	}

	const term = query.trim().toLocaleLowerCase()
	const list = term
		? conversations.filter((conversation) => conversationLabel(conversation).toLocaleLowerCase().includes(term))
		: conversations

	return (
		<Sheet title={t("folders")} icon={<IGallery />} iconShape="pentagon" iconTone="teal" onClose={onClose} size="md">
			<TextField
				label={t("folderNamePlaceholder")}
				maxLength={FOLDER_NAME_MAX}
				value={name}
				disabled={busy}
				onChange={setName}
				onEnter={() => void createFolder()}
				trailing={<Button variant="filled" icon={<IAdd size={18} />} disabled={busy || !name.trim()} onClick={() => void createFolder()}>{t("createFolder")}</Button>}
			/>
			{error ? <Banner tone="error">{error}</Banner> : null}
			{folders.length === 0 ? (
				<p className="settings-intro">{t("noFolders")}</p>
			) : (
				<div className="m3-chip-row folder-chips">
					{folders.map((folder) => (
						<Chip key={folder.id} selected={folder.id === selectedId} onClick={() => setSelectedId(folder.id)}>
							{folder.name} · {folder.conversationIds.length}
						</Chip>
					))}
				</div>
			)}
			{selected ? (
				<>
					<ListGroup label={t("folderChats") + ": " + selected.name}>
						<ListItem title={t("deleteAction") + " «" + selected.name + "»"} icon={<ITrash />} shape="clover" danger disabled={busy} onClick={() => void removeFolder(selected)} />
					</ListGroup>
					<TextField label={t("searchChats")} type="search" value={query} disabled={busy} onChange={setQuery} />
					{list.length === 0 ? (
						<p className="settings-intro">{t("noChatsYet")}</p>
					) : (
						<ListGroup>
							{list.map((conversation) => {
								const inFolder = selected.conversationIds.includes(conversation.id)
								return (
									<ListItem
										key={conversation.id}
										leading={<Avatar src={conversation.avatar || conversation.peer?.avatar} label={conversationLabel(conversation)} seed={conversation.peer?.id ?? conversation.id} size={36} shape={conversation.kind === "group" ? "group" : conversation.kind === "channel" ? "channel" : "circle"} />}
										title={conversationLabel(conversation)}
										onClick={busy ? undefined : () => void toggleChat(conversation.id, !inFolder)}
										trailing={<Switch checked={inFolder} disabled={busy} onChange={(next) => void toggleChat(conversation.id, next)} label={conversationLabel(conversation)} />}
									/>
								)
							})}
						</ListGroup>
					)}
				</>
			) : folders.length > 0 ? (
				<p className="settings-intro">{t("selectFolderHint")}</p>
			) : null}
		</Sheet>
	)
}
