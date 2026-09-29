import type { DisplayMessage } from "../lib/types"
import { useSettings } from "../state/settings"
import { IconButton, ListGroup, ListItem, Sheet } from "./m3"
import { IClose, IPin } from "./m3icons"

// The pinned bar shows only the latest pin; this lists them all.
export function PinnedDialog({
	messages,
	canModerate,
	onClose,
	onJump,
	onUnpin,
	previewText,
	authorOf,
}: {
	messages: DisplayMessage[]
	canModerate: boolean
	onClose: () => void
	onJump: (messageId: string) => void
	onUnpin: (messageId: string) => void
	previewText: (message: DisplayMessage) => string
	authorOf: (message: DisplayMessage) => string
}) {
	const { t } = useSettings()
	return (
		<Sheet title={t("pinnedTitle")} icon={<IPin />} iconShape="clover" iconTone="orange" onClose={onClose} size="md">
			{messages.length === 0 ? (
				<p className="settings-intro">{t("pinnedEmpty")}</p>
			) : (
				<ListGroup>
					{messages.map((message) => (
						<ListItem
							key={message.id}
							title={authorOf(message)}
							subtitle={previewText(message)}
							onClick={() => onJump(message.id)}
							trailing={canModerate ? (
								<IconButton label={t("unpin")} size="s" onClick={(event) => { event.stopPropagation(); onUnpin(message.id) }}>
									<IClose size={16} />
								</IconButton>
							) : null}
						/>
					))}
				</ListGroup>
			)}
		</Sheet>
	)
}
