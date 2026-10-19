import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react"
import type { Conversation, UserProfile } from "../lib/types"
import { api } from "../lib/api"
import { errorText } from "../lib/errorText"
import { formatDate, formatLastSeen, plural } from "../lib/i18n"
import { isVideoMedia, type MediaEnvelope } from "../lib/media"
import { renderRichText } from "../lib/richtext"
import { EMPTY_SHARED, loadSharedContent, type SharedContent, type SharedLink, type SharedMediaItem } from "../lib/sharedMedia"
import { useSettings } from "../state/settings"
import { AvatarLightbox } from "./AvatarLightbox"
import { BotBadge } from "./BotBadge"
import { LoadingIndicator, MorphBlob, WavyCircle } from "./Expressive"
import { GalleryTile } from "./GalleryDialog"
import { MediaViewer, type ViewerItem } from "./MediaViewer"
import { formatBytes } from "./MessageThread"
import { Avatar, Banner, Button, IconButton, ListGroup, ListItem, Sheet, useSheetClose } from "./m3"
import { IAdd, IBot, IChat, IClose, IDownload, IEdit, IFile, IGallery, IGif, IInfo, ILink, IPeople, IPerson, IShield } from "./m3icons"
import { CopyButton } from "./settings/common"

export type ProfileTarget =
	| { kind: "user"; userId: string; seed?: { displayName: string; username: string; avatar: string | null } }
	| { kind: "chat"; conversationId: string }

type Tab = "media" | "files" | "links" | "gifs" | "groups"
type Resolve = (media: MediaEnvelope, onProgress?: (ratio: number) => void) => Promise<string | null>

// Becomes true once the element has come near the screen, and stays true:
// tiles decrypt their picture only when someone scrolls to them.
function useSeen<T extends Element>(): [React.RefObject<T>, boolean] {
	const ref = useRef<T>(null)
	const [seen, setSeen] = useState(false)
	useEffect(() => {
		const node = ref.current
		if (!node || seen) return
		if (typeof IntersectionObserver === "undefined") {
			setSeen(true)
			return
		}
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				setSeen(true)
				observer.disconnect()
			}
		}, { rootMargin: "240px" })
		observer.observe(node)
		return () => observer.disconnect()
	}, [seen])
	return [ref, seen]
}

function LazyTile(props: { item: ViewerItem; onResolveMedia: Resolve; onOpen: () => void }) {
	const [ref, seen] = useSeen<HTMLDivElement>()
	return (
		<div ref={ref} className="profile-tile-slot">
			{seen ? <GalleryTile item={props.item} onResolveMedia={props.onResolveMedia} onOpen={props.onOpen} /> : <span className="gallery-tile gallery-blank" aria-hidden="true" />}
		</div>
	)
}

// GIFs travel as short silent clips (or real GIF images) and play in place.
function GifTile(props: { item: SharedMediaItem; onResolveMedia: Resolve; onOpen: () => void }) {
	const [ref, seen] = useSeen<HTMLButtonElement>()
	const [url, setUrl] = useState<string | null>(null)
	useEffect(() => {
		if (!seen) return
		let active = true
		void props.onResolveMedia(props.item.media).then((resolved) => { if (active) setUrl(resolved) }).catch(() => undefined)
		return () => { active = false }
	}, [seen, props.item.media.fileId])
	const clip = isVideoMedia(props.item.media) || props.item.media.mime.indexOf("video/") === 0
	return (
		<button ref={ref} type="button" className="gallery-tile profile-gif" onClick={props.onOpen}>
			{url ? (clip ? <video src={url} autoPlay muted loop playsInline /> : <img src={url} alt="" />) : <span className="gallery-blank" aria-hidden="true" />}
			<span className="gallery-video-mark" aria-hidden="true"><em>GIF</em></span>
		</button>
	)
}

function FileRow(props: { item: SharedMediaItem; onResolveMedia: Resolve }) {
	const { t, lang } = useSettings()
	const [progress, setProgress] = useState<number | null>(null)
	const [failed, setFailed] = useState(false)
	const download = async () => {
		if (progress !== null) return
		setProgress(0)
		setFailed(false)
		try {
			const url = await props.onResolveMedia(props.item.media, (ratio) => setProgress(ratio))
			if (!url) throw new Error("no file")
			const link = document.createElement("a")
			link.href = url
			link.download = props.item.media.name || "file"
			document.body.appendChild(link)
			link.click()
			link.remove()
		} catch {
			setFailed(true)
		} finally {
			setProgress(null)
		}
	}
	const date = formatDate(lang, new Date(props.item.createdAt), { day: "numeric", month: "short", year: "numeric" })
	const size = formatBytes(props.item.media.size)
	return (
		<ListItem
			icon={<IFile />}
			shape="cookie"
			tone={failed ? "error" : "blue"}
			title={props.item.media.name || t("file")}
			subtitle={failed ? t("downloadFailed") : [size, date].filter(Boolean).join(" · ")}
			onClick={() => void download()}
			trailing={progress !== null ? <WavyCircle value={progress > 0 ? progress : null} size={28} /> : <IDownload size={18} />}
		/>
	)
}

function LinkRow(props: { link: SharedLink }) {
	const { link } = props
	const host = (() => {
		try {
			return new URL(link.url).hostname.replace(/^www\./, "")
		} catch {
			return link.url
		}
	})()
	return (
		<ListItem
			href={link.url}
			leading={link.image ? <img className="profile-link-thumb" src={link.image} alt="" /> : undefined}
			icon={link.image ? undefined : <ILink />}
			shape="clover"
			tone="teal"
			title={link.title || host}
			subtitle={link.description ? link.description + "\n" + link.url : link.url}
			multiline
		/>
	)
}

// Primary tabs with an indicator that slides (and stretches) to the chosen one.
function ProfileTabs(props: { tabs: Array<{ value: Tab; label: string; count?: number; icon: ReactNode }>; value: Tab; onChange: (tab: Tab) => void }) {
	const listRef = useRef<HTMLDivElement>(null)
	const [bar, setBar] = useState<{ left: number; width: number } | null>(null)
	useLayoutEffect(() => {
		const list = listRef.current
		if (!list) return
		const measure = () => {
			const button = list.querySelector<HTMLButtonElement>('[aria-selected="true"]')
			if (!button) return
			setBar({ left: button.offsetLeft + 10, width: button.offsetWidth - 20 })
			const start = button.offsetLeft - 16
			const end = button.offsetLeft + button.offsetWidth + 16
			if (start < list.scrollLeft) list.scrollTo({ left: start, behavior: "smooth" })
			else if (end > list.scrollLeft + list.clientWidth) list.scrollTo({ left: end - list.clientWidth, behavior: "smooth" })
		}
		measure()
		const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null
		observer?.observe(list)
		return () => observer?.disconnect()
	}, [props.value, props.tabs.map((tab) => tab.value + ":" + (tab.count ?? "")).join(",")])
	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return
		event.preventDefault()
		const index = props.tabs.findIndex((tab) => tab.value === props.value)
		const next = props.tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + props.tabs.length) % props.tabs.length]
		props.onChange(next.value)
		window.setTimeout(() => listRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(), 0)
	}
	return (
		<div ref={listRef} className="profile-tabs" role="tablist" onKeyDown={onKeyDown}>
			{props.tabs.map((tab) => (
				<button
					key={tab.value}
					type="button"
					role="tab"
					aria-selected={tab.value === props.value}
					tabIndex={tab.value === props.value ? 0 : -1}
					className={"profile-tab" + (tab.value === props.value ? " active" : "")}
					onClick={() => props.onChange(tab.value)}
				>
					<span className="profile-tab-icon" aria-hidden="true">
						{tab.icon}
						{tab.count ? <span className="profile-tab-count">{tab.count > 999 ? "999+" : tab.count}</span> : null}
					</span>
					<span className="profile-tab-label">{tab.label}</span>
					{tab.count ? <span className="visually-hidden">{" (" + tab.count + ")"}</span> : null}
				</button>
			))}
			{bar ? <span className="profile-tabs-bar" style={{ left: bar.left, width: bar.width }} aria-hidden="true" /> : null}
		</div>
	)
}

function ActionButton(props: { icon: ReactNode; label: string; onClick: () => void; busy?: boolean }) {
	return (
		<button type="button" className="profile-action" onClick={props.onClick} disabled={props.busy}>
			<span className="profile-action-icon" aria-hidden="true">{props.icon}</span>
			<span className="profile-action-label">{props.label}</span>
		</button>
	)
}

function Empty(props: { text: string }) {
	return (
		<div className="profile-empty">
			<MorphBlob className="profile-empty-blob" size={84} shapes={[2, 5, 1, 6]} />
			<span>{props.text}</span>
		</div>
	)
}

function CloseButton() {
	const close = useSheetClose()
	const { t } = useSettings()
	return (
		<IconButton label={t("close")} onClick={close} variant="tonal" className="profile-close">
			<IClose />
		</IconButton>
	)
}

// A person's or a chat's profile: the picture (opens at full size), name,
// presence, "about" or description, a personal channel, and below everything
// what the chat with them has shared, sorted into tabs.
export function ProfileDialog(props: {
	target: ProfileTarget
	currentUserId: string
	conversations: Conversation[]
	activeConversationId: string | null
	titleOf: (conversation: Conversation) => string
	authorName: (senderId: string) => string
	memberCount?: number
	onlineCount?: number
	canManage?: boolean
	onClose: () => void
	onOpenChat: (conversationId: string) => void
	onAddFriend: (username: string) => void
	onShowMembers: () => void
	onShowSafety: (name: string, userId: string) => void
	onEditOwnProfile: () => void
	onJoinedChannel: (conversation: Conversation) => void
	onResolveMedia: Resolve
}) {
	const { t, lang } = useSettings()
	const { target } = props
	const userId = target.kind === "user" ? target.userId : null
	const self = userId === props.currentUserId
	const chat = target.kind === "chat" ? props.conversations.find((item) => item.id === target.conversationId) ?? null : null
	const [profile, setProfile] = useState<UserProfile | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [shared, setShared] = useState<SharedContent>(EMPTY_SHARED)
	const [sharedLoading, setSharedLoading] = useState(false)
	const [tab, setTab] = useState<Tab | null>(null)
	const [joining, setJoining] = useState(false)
	const [lightbox, setLightbox] = useState<{ src: string; name: string; from: DOMRect | null; round: boolean } | null>(null)
	const [viewer, setViewer] = useState<{ items: ViewerItem[]; index: number } | null>(null)
	const [now, setNow] = useState(() => Date.now())

	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 30000)
		return () => window.clearInterval(timer)
	}, [])

	useEffect(() => {
		if (!userId) return
		let active = true
		setProfile(null)
		setError(null)
		api
			.getUserProfile(userId)
			.then((res) => { if (active) setProfile(res) })
			.catch((err) => { if (active) setError(errorText(err, t("profileLoadFailed"))) })
		return () => { active = false }
	}, [userId])

	const sharedId = chat ? chat.id : self ? null : profile?.directConversationId ?? null
	const skipReplies = chat?.kind === "channel"
	useEffect(() => {
		setShared(EMPTY_SHARED)
		if (!sharedId) {
			setSharedLoading(false)
			return
		}
		const signal = { cancelled: false }
		setSharedLoading(true)
		void loadSharedContent(sharedId, { skipReplies, signal, onPage: (partial) => { if (!signal.cancelled) setShared(partial) } })
			.then((result) => { if (!signal.cancelled) setShared(result) })
			.catch(() => undefined)
			.finally(() => { if (!signal.cancelled) setSharedLoading(false) })
		return () => { signal.cancelled = true }
	}, [sharedId, skipReplies])

	const nameOf = (senderId: string): string => {
		if (senderId === props.currentUserId) return t("you")
		if (profile && senderId === profile.user.id) return profile.user.displayName || profile.user.username
		return props.authorName(senderId)
	}
	const mediaItems = useMemo<ViewerItem[]>(() => shared.media.map((item) => ({ messageId: item.messageId, media: item.media, author: nameOf(item.senderId), createdAt: item.createdAt })), [shared.media, profile])
	const gifItems = useMemo<ViewerItem[]>(() => shared.gifs.map((item) => ({ messageId: item.messageId, media: item.media, author: nameOf(item.senderId), createdAt: item.createdAt })), [shared.gifs, profile])

	const commonGroups = profile?.commonGroups ?? []
	const tabs: Array<{ value: Tab; label: string; count?: number; icon: ReactNode }> = [
		...(sharedId
			? ([
				{ value: "media", label: t("tabMedia"), count: shared.media.length, icon: <IGallery size={20} /> },
				{ value: "files", label: t("tabFiles"), count: shared.files.length, icon: <IFile size={20} /> },
				{ value: "links", label: t("tabLinks"), count: shared.links.length, icon: <ILink size={20} /> },
				{ value: "gifs", label: t("tabGifs"), count: shared.gifs.length, icon: <IGif size={20} /> },
			] as const)
			: []),
		...(commonGroups.length > 0 ? [{ value: "groups" as const, label: t("tabGroups"), count: commonGroups.length, icon: <IPeople size={20} /> }] : []),
	]
	const activeTab: Tab | null = tab && tabs.some((item) => item.value === tab) ? tab : tabs[0]?.value ?? null

	const openAvatar = (event: ReactMouseEvent<HTMLButtonElement>, src: string | null | undefined, name: string, round: boolean) => {
		if (!src) return
		const node = event.currentTarget.querySelector(".m3-avatar") ?? event.currentTarget
		setLightbox({ src, name, from: node.getBoundingClientRect(), round })
	}

	const joinChannel = async () => {
		if (!profile || joining) return
		setJoining(true)
		setError(null)
		try {
			const res = await api.joinPersonalChannel(profile.user.id)
			props.onJoinedChannel(res.conversation)
		} catch (err) {
			setError(errorText(err, t("channelJoinFailed")))
			setJoining(false)
		}
	}

	// --- the top: picture, name, presence ---
	let heroName = ""
	let heroSub: ReactNode = null
	let heroAvatar: ReactNode = null
	let avatarSrc: string | null = null
	let round = true
	if (target.kind === "user") {
		const info = profile?.user ?? (target.seed ? { ...target.seed, id: target.userId, bio: null, isBot: false } : null)
		heroName = info ? info.displayName || info.username : ""
		avatarSrc = info?.avatar ?? null
		heroAvatar = <Avatar src={avatarSrc} label={heroName || "?"} seed={target.userId} size={112} />
		if (profile) {
			heroSub = profile.user.isBot ? (
				<span className="profile-sub-bot"><IBot size={14} /> {t("kindBot")}</span>
			) : self || profile.online ? (
				<span className="profile-online"><span className="presence-dot online" aria-hidden="true" />{t("online")}</span>
			) : profile.lastSeenAt ? (
				formatLastSeen(lang, profile.lastSeenAt, now)
			) : (
				t("lastSeenRecently")
			)
		}
	} else if (chat) {
		heroName = props.titleOf(chat)
		avatarSrc = chat.avatar ?? null
		round = false
		heroAvatar = <Avatar src={avatarSrc} label={heroName || "?"} seed={chat.id} size={112} shape={chat.kind === "channel" ? "channel" : "group"} />
		const count = props.memberCount ?? 0
		heroSub = (
			<>
				{chat.kind === "channel" ? plural(lang, "subscribersCount", count) : plural(lang, "membersCount", count)}
				{props.onlineCount ? <span className="profile-online"><span className="presence-dot online" aria-hidden="true" />{props.onlineCount} {t("online")}</span> : null}
			</>
		)
	}

	const panel = (() => {
		if (!activeTab) return null
		if (activeTab === "groups") {
			return (
				<ListGroup>
					{commonGroups.map((group) => (
						<ListItem
							key={group.id}
							leading={<Avatar src={group.avatar} label={group.title || "?"} seed={group.id} size={40} shape="group" />}
							title={group.title || t("kindGroup")}
							subtitle={plural(lang, "membersCount", group.memberCount)}
							onClick={() => props.onOpenChat(group.id)}
							chevron
						/>
					))}
				</ListGroup>
			)
		}
		const empty = activeTab === "media" ? shared.media.length === 0 : activeTab === "files" ? shared.files.length === 0 : activeTab === "links" ? shared.links.length === 0 : shared.gifs.length === 0
		if (empty) {
			if (sharedLoading) return <div className="profile-loading"><LoadingIndicator size={44} /><span>{t("sharedLoading")}</span></div>
			return <Empty text={t(activeTab === "media" ? "sharedEmptyMedia" : activeTab === "files" ? "sharedEmptyFiles" : activeTab === "links" ? "sharedEmptyLinks" : "sharedEmptyGifs")} />
		}
		if (activeTab === "media") {
			return (
				<div className="gallery-grid profile-grid">
					{mediaItems.map((item, index) => (
						<LazyTile key={item.messageId + ":" + item.media.fileId} item={item} onResolveMedia={props.onResolveMedia} onOpen={() => setViewer({ items: mediaItems, index })} />
					))}
				</div>
			)
		}
		if (activeTab === "gifs") {
			return (
				<div className="gallery-grid profile-grid">
					{shared.gifs.map((item, index) => (
						<GifTile key={item.messageId + ":" + item.media.fileId} item={item} onResolveMedia={props.onResolveMedia} onOpen={() => setViewer({ items: gifItems, index })} />
					))}
				</div>
			)
		}
		if (activeTab === "files") {
			return (
				<ListGroup>
					{shared.files.map((item) => <FileRow key={item.messageId + ":" + item.media.fileId} item={item} onResolveMedia={props.onResolveMedia} />)}
				</ListGroup>
			)
		}
		return (
			<ListGroup>
				{shared.links.map((link, index) => <LinkRow key={link.messageId + ":" + index} link={link} />)}
			</ListGroup>
		)
	})()

	const username = profile?.user.username ?? (target.kind === "user" ? target.seed?.username : undefined)
	const bio = profile?.user.bio ?? null
	const channel = profile?.personalChannel ?? null
	const direct = profile?.directConversationId ?? null

	return (
		<Sheet onClose={props.onClose} size="md" hideHeader className="profile-sheet" dismissible={!viewer}>
			<CloseButton />
			<header className="profile-hero">
				<span className="profile-hero-art" aria-hidden="true">
					<MorphBlob size={200} shapes={round ? [0, 2, 5, 1] : [1, 6, 2, 7]} />
				</span>
				<button
					type="button"
					className={"profile-avatar" + (avatarSrc ? " has-photo" : "")}
					onClick={(event) => openAvatar(event, avatarSrc, heroName, round)}
					aria-label={avatarSrc ? t("openPhoto") : heroName}
					disabled={!avatarSrc}
				>
					{heroAvatar}
				</button>
				<h2 className="profile-name">
					{heroName}
					{profile?.user.isBot ? <BotBadge size={12} /> : null}
				</h2>
				{heroSub ? <p className="profile-sub">{heroSub}</p> : target.kind === "user" && !error ? <p className="profile-sub"><LoadingIndicator size={22} /></p> : null}
			</header>

			{target.kind === "user" && profile ? (
				<div className="profile-actions">
					{self ? <ActionButton icon={<IEdit />} label={t("profileEdit")} onClick={props.onEditOwnProfile} /> : null}
					{!self && direct ? <ActionButton icon={<IChat />} label={t("profileMessage")} onClick={() => props.onOpenChat(direct)} /> : null}
					{!self && !direct ? <ActionButton icon={<IAdd />} label={profile.user.isBot ? t("profileMessage") : t("profileAddFriend")} onClick={() => props.onAddFriend(profile.user.username)} /> : null}
					{!self && direct && !profile.user.isBot ? <ActionButton icon={<IShield />} label={t("profileSafety")} onClick={() => props.onShowSafety(heroName, profile.user.id)} /> : null}
				</div>
			) : null}
			{chat ? (
				<div className="profile-actions">
					{chat.id !== props.activeConversationId ? <ActionButton icon={<IChat />} label={t("profileOpenChat")} onClick={() => props.onOpenChat(chat.id)} /> : null}
					<ActionButton icon={<IPeople />} label={t("members")} onClick={props.onShowMembers} />
					{props.canManage ? <ActionButton icon={<IEdit />} label={t("profileEdit")} onClick={props.onShowMembers} /> : null}
				</div>
			) : null}

			{error ? <Banner tone="error">{error}</Banner> : null}

			{target.kind === "user" && username ? (
				<ListGroup>
					<ListItem icon={<IPerson />} shape="circle" tone="secondary" title={"@" + username} subtitle={t("usernameLabel")} trailing={<CopyButton value={"@" + username} label={t("copy")} />} />
					{bio ? <ListItem icon={<IInfo />} shape="circle" tone="secondary" title={<span className="profile-text">{renderRichText(bio)}</span>} subtitle={profile?.user.isBot ? t("descriptionLabel") : t("bioLabel")} multiline /> : null}
				</ListGroup>
			) : null}

			{chat && (chat.description || props.canManage) ? (
				<ListGroup>
					{chat.description ? (
						<ListItem icon={<IInfo />} shape="circle" tone="secondary" title={<span className="profile-text">{renderRichText(chat.description)}</span>} subtitle={t("descriptionLabel")} multiline />
					) : (
						<ListItem icon={<IEdit />} shape="circle" tone="secondary" title={t("descriptionAdd")} subtitle={t("descriptionHint")} onClick={props.onShowMembers} chevron />
					)}
				</ListGroup>
			) : null}

			{channel ? (
				<ListGroup label={t("personalChannel")}>
					<ListItem
						className="profile-channel"
						leading={<Avatar src={channel.avatar} label={channel.title || "?"} seed={channel.id} size={44} shape="channel" />}
						title={channel.title || t("kindChannel")}
						subtitle={plural(lang, "subscribersCount", channel.memberCount) + (channel.description ? "\n" + channel.description : "")}
						multiline
						trailing={
							channel.isMember ? (
								<Button variant="tonal" onClick={() => props.onOpenChat(channel.id)}>{t("channelOpen")}</Button>
							) : (
								<Button variant="filled" busy={joining} onClick={() => void joinChannel()}>{t("channelJoin")}</Button>
							)
						}
					/>
				</ListGroup>
			) : null}

			{activeTab ? (
				<section className="profile-shared">
					<ProfileTabs tabs={tabs} value={activeTab} onChange={setTab} />
					<div className="profile-panel" role="tabpanel" key={activeTab}>
						{panel}
						{sharedLoading && activeTab !== "groups" && !(activeTab === "media" ? shared.media.length === 0 : activeTab === "files" ? shared.files.length === 0 : activeTab === "links" ? shared.links.length === 0 : shared.gifs.length === 0) ? (
							<div className="profile-loading inline"><LoadingIndicator size={28} /></div>
						) : null}
						{!sharedLoading && sharedId && !shared.complete && activeTab !== "groups" ? <p className="profile-note">{t("sharedPartial")}</p> : null}
					</div>
				</section>
			) : null}

			{lightbox ? <AvatarLightbox src={lightbox.src} name={lightbox.name} from={lightbox.from} round={lightbox.round} onClose={() => setLightbox(null)} /> : null}
			{viewer && viewer.items[viewer.index] ? (
				<MediaViewer
					items={viewer.items}
					index={viewer.index}
					onIndexChange={(index) => setViewer((current) => (current ? { ...current, index } : current))}
					onClose={() => setViewer(null)}
					onResolveMedia={props.onResolveMedia}
				/>
			) : null}
		</Sheet>
	)
}
