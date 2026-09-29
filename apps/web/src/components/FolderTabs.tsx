import { useEffect, useRef } from "react"
import type { ConversationFolder } from "../lib/types"
import { useSettings } from "../state/settings"

export function FolderTabs({
	folders,
	activeFolderId,
	allUnread,
	folderUnread,
	onSelect,
	onManage,
}: {
	folders: ConversationFolder[]
	activeFolderId: string | null
	allUnread: number
	folderUnread: Record<string, number>
	onSelect: (folderId: string | null) => void
	onManage: () => void
}) {
	const { t } = useSettings()
	const stripRef = useRef<HTMLDivElement | null>(null)
	const activeRef = useRef<HTMLButtonElement | null>(null)

	// A mouse wheel over the strip scrolls it sideways. React attaches wheel
	// handlers passively, so the listener is registered by hand to be able to
	// swallow the vertical scroll.
	useEffect(() => {
		const strip = stripRef.current
		if (!strip) return
		const onWheel = (event: WheelEvent) => {
			if (strip.scrollWidth <= strip.clientWidth) return
			const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
			if (delta === 0) return
			event.preventDefault()
			strip.scrollLeft += delta
		}
		strip.addEventListener("wheel", onWheel, { passive: false })
		return () => strip.removeEventListener("wheel", onWheel)
	}, [])

	// Keep the selected tab in sight, including right after a reload when the
	// tab restored from storage sits far to the right.
	useEffect(() => {
		const tab = activeRef.current
		if (!tab) return
		tab.scrollIntoView({ block: "nearest", inline: "nearest" })
	}, [activeFolderId, folders.length])

	return (
		<div className="folder-tabs" role="tablist" aria-label={t("folders")} ref={stripRef}>
			<button
				type="button"
				role="tab"
				ref={activeFolderId === null ? activeRef : undefined}
				className={"folder-tab" + (activeFolderId === null ? " active" : "")}
				aria-selected={activeFolderId === null}
				onClick={() => onSelect(null)}
			>
				{t("allChats")}
				{allUnread > 0 ? <span className="folder-tab-badge">{allUnread}</span> : null}
			</button>
			{folders.map((folder) => (
				<button
					key={folder.id}
					type="button"
					role="tab"
					ref={activeFolderId === folder.id ? activeRef : undefined}
					className={"folder-tab" + (activeFolderId === folder.id ? " active" : "")}
					aria-selected={activeFolderId === folder.id}
					onClick={() => onSelect(folder.id)}
					title={folder.name}
				>
					{folder.name}
					{(folderUnread[folder.id] ?? 0) > 0 ? <span className="folder-tab-badge">{folderUnread[folder.id]}</span> : null}
				</button>
			))}
			<button type="button" className="folder-tab folder-tab-manage" title={t("manageFolders")} aria-label={t("manageFolders")} onClick={onManage}>
				<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
					<line x1="12" y1="5" x2="12" y2="19" />
					<line x1="5" y1="12" x2="19" y2="12" />
				</svg>
			</button>
		</div>
	)
}
