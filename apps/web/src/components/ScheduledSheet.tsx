import { useEffect, useState } from "react"
import { api } from "../lib/api"
import { activeKeyring } from "../lib/keyring"
import { formatDateTime } from "../lib/i18n"
import { errorText } from "../lib/errorText"
import { parseMediaMessage } from "../lib/media"
import { parseContact, parseLocation } from "../lib/richmsg"
import { parseLinkMessage } from "../lib/linkmsg"
import { stripFormatting } from "../lib/richtext"
import type { MessageEnvelope, ScheduledMessage } from "../lib/types"
import { useSettings } from "../state/settings"
import { LoadingBlock } from "./Expressive"
import { ScheduleSheet } from "./ScheduleSheet"
import { Banner, IconButton, ListGroup, ListItem, Sheet } from "./m3"
import { IClock, ISchedule, ISend, ISilent, ITrash } from "./m3icons"

// Your messages waiting to go out in this chat. They are sealed already; the
// server sends them at their time even if no device of yours is online.
export function ScheduledSheet(props: { conversationId: string; version: number; onClose: () => void; onSent: (message: MessageEnvelope) => void }) {
	const { t, lang } = useSettings()
	const [items, setItems] = useState<Array<ScheduledMessage & { preview: string }> | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [editing, setEditing] = useState<ScheduledMessage | null>(null)

	const load = async () => {
		try {
			const res = await api.listScheduled(props.conversationId)
			const keyring = activeKeyring()
			const out: Array<ScheduledMessage & { preview: string }> = []
			for (const item of res.scheduled) {
				let preview = t("messageEncrypted")
				try {
					const plain = keyring ? await keyring.decrypt(props.conversationId, item.ciphertext) : ""
					const media = parseMediaMessage(plain)
					const location = parseLocation(plain)
					const contact = parseContact(plain)
					const link = parseLinkMessage(plain)
					preview = media
						? (media.kind === "image" ? t("photo") : media.kind === "voice" ? t("voiceMessage") : media.name) + (media.caption ? " · " + stripFormatting(media.caption) : "")
						: location ? t("locationShort") + (location.label ? " · " + location.label : "")
						: contact ? t("contactShort") + " · " + contact.displayName
						: stripFormatting(link ? link.text : plain)
				} catch {
					// keep the placeholder
				}
				out.push({ ...item, preview })
			}
			setItems(out)
		} catch (err) {
			setError(errorText(err, t("scheduledLoadFailed")))
		}
	}

	useEffect(() => {
		void load()
	}, [props.conversationId, props.version])

	const act = async (action: () => Promise<void>) => {
		setError(null)
		try {
			await action()
			await load()
		} catch (err) {
			setError(errorText(err, t("scheduledActionFailed")))
		}
	}

	return (
		<Sheet title={t("scheduledTitle")} icon={<ISchedule />} iconShape="sunny" iconTone="orange" onClose={props.onClose} size="md">
			{error ? <Banner tone="error">{error}</Banner> : null}
			{!items ? (
				<LoadingBlock size={40} />
			) : items.length === 0 ? (
				<p className="settings-intro">{t("scheduledEmpty")}</p>
			) : (
				<ListGroup>
					{items.map((item) => (
						<ListItem
							key={item.id}
							icon={item.silent ? <ISilent /> : <IClock />}
							shape="circle"
							tone={item.silent ? "neutral" : "orange"}
							title={item.preview || t("messageEncrypted")}
							subtitle={formatDateTime(lang, item.sendAt) + (item.silent ? " · " + t("silentShort") : "")}
							trailing={
								<span className="m3-row scheduled-actions">
									<IconButton label={t("scheduleChange")} size="s" onClick={() => setEditing(item)}><ISchedule size={18} /></IconButton>
									<IconButton label={t("scheduleSendNow")} size="s" onClick={() => void act(async () => { const res = await api.sendScheduledNow(props.conversationId, item.id); if (res.message) props.onSent(res.message) })}><ISend size={16} /></IconButton>
									<IconButton label={t("deleteAction")} size="s" onClick={() => void act(async () => { await api.deleteScheduled(props.conversationId, item.id) })}><ITrash size={18} /></IconButton>
								</span>
							}
						/>
					))}
				</ListGroup>
			)}
			{editing ? (
				<ScheduleSheet
					title={t("scheduleChange")}
					initial={editing.sendAt}
					silent={editing.silent}
					onClose={() => setEditing(null)}
					onPick={(sendAt, silent) => void act(async () => { await api.updateScheduled(props.conversationId, editing.id, { sendAt, silent }) })}
				/>
			) : null}
		</Sheet>
	)
}
