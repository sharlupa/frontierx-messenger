import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "../lib/api"
import { formatDateTime } from "../lib/i18n"
import type { StringKey } from "../lib/i18n"
import { normalize, snippet, type SearchEngine, type SearchFilter, type SearchItem, type SearchKind } from "../lib/search"
import type { Conversation, UserSummary } from "../lib/types"
import { useSettings } from "../state/settings"
import { LoadingIndicator, MorphBlob, WavyProgress } from "./Expressive"
import { Avatar, Chip } from "./m3"
import { IBot, IContact, IFile, IImage, ILink, ILocation, IMic, IPoll, ISearch } from "./m3icons"

const FILTERS: Array<{ id: SearchFilter; label: StringKey }> = [
	{ id: "all", label: "searchAll" },
	{ id: "media", label: "searchMedia" },
	{ id: "links", label: "searchLinks" },
	{ id: "files", label: "searchFiles" },
	{ id: "voice", label: "searchVoice" },
	{ id: "places", label: "searchPlaces" },
]

function kindIcon(kind: SearchKind) {
	switch (kind) {
		case "photo":
		case "video":
			return <IImage size={16} />
		case "file":
			return <IFile size={16} />
		case "voice":
			return <IMic size={16} />
		case "poll":
			return <IPoll size={16} />
		case "location":
			return <ILocation size={16} />
		case "contact":
			return <IContact size={16} />
		case "link":
			return <ILink size={16} />
		default:
			return null
	}
}

// Everything that matches, across all chats: the chats themselves, people to
// start a chat with, and messages (decrypted on this device).
export function GlobalSearch(props: {
	query: string
	engine: SearchEngine | null
	conversations: Conversation[]
	titleOf: (conversation: Conversation) => string
	nameOf: (userId: string) => string
	onOpenConversation: (conversationId: string) => void
	onOpenMessage: (conversationId: string, messageId: string) => void
	onStartChat: (user: UserSummary) => void
}) {
	const { t, lang } = useSettings()
	const [filter, setFilter] = useState<SearchFilter>("all")
	const [tick, setTick] = useState(0)
	const [people, setPeople] = useState<UserSummary[]>([])
	const [scanning, setScanning] = useState(false)
	const engine = props.engine
	const query = props.query.trim()
	const filtersRef = useRef<HTMLDivElement>(null)

	// The filters do not fit in a narrow sidebar: besides the scrollbar under
	// them, a mouse wheel scrolls them sideways, and the chosen one is kept in view.
	useEffect(() => {
		const row = filtersRef.current
		if (!row) return
		const onWheel = (event: WheelEvent) => {
			if (row.scrollWidth <= row.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
			event.preventDefault()
			row.scrollBy({ left: event.deltaY, behavior: "auto" })
		}
		row.addEventListener("wheel", onWheel, { passive: false })
		return () => row.removeEventListener("wheel", onWheel)
	}, [])

	// Index the history in the background while the panel is open.
	useEffect(() => {
		if (!engine || engine.done) return
		let alive = true
		setScanning(true)
		void engine
			.scan(() => {
				if (alive) setTick((value) => value + 1)
			})
			.catch(() => undefined)
			.finally(() => {
				if (alive) {
					setScanning(false)
					setTick((value) => value + 1)
				}
			})
		return () => {
			alive = false
		}
	}, [engine])

	// People by username, for starting a new chat.
	const peopleTimer = useRef<number | null>(null)
	useEffect(() => {
		if (peopleTimer.current) window.clearTimeout(peopleTimer.current)
		if (query.length < 2 || filter !== "all") {
			setPeople([])
			return
		}
		peopleTimer.current = window.setTimeout(() => {
			void api.searchUsers(query.replace(/^@/, "")).then((res) => setPeople(res.users)).catch(() => setPeople([]))
		}, 280)
	}, [query, filter])

	const chats = useMemo(() => {
		if (!query || filter !== "all") return []
		const term = normalize(query)
		return props.conversations.filter((conversation) => {
			const title = normalize(props.titleOf(conversation))
			const handle = conversation.peer ? normalize(conversation.peer.username) : ""
			return title.includes(term) || handle.includes(term.replace(/^@/, ""))
		}).slice(0, 12)
	}, [query, filter, props.conversations, props.titleOf])

	const knownPeers = useMemo(() => new Set(props.conversations.map((conversation) => conversation.peer?.id).filter(Boolean) as string[]), [props.conversations])
	const strangers = people.filter((person) => !knownPeers.has(person.id))

	const messages: SearchItem[] = useMemo(() => {
		void tick
		if (!engine) return []
		if (!query && filter === "all") return []
		return engine.search(query, filter, 150)
	}, [engine, query, filter, tick])

	const convById = useMemo(() => new Map(props.conversations.map((conversation) => [conversation.id, conversation])), [props.conversations])
	const nothing = chats.length === 0 && strangers.length === 0 && messages.length === 0

	return (
		<div className="global-search" role="region" aria-label={t("searchEverywhere")}>
			<div ref={filtersRef} className="m3-chip-row global-search-filters" role="toolbar" aria-label={t("searchEverywhere")}>
				{FILTERS.map((item) => (
					<Chip
						key={item.id}
						selected={filter === item.id}
						onClick={() => {
							setFilter(item.id)
							const row = filtersRef.current
							const chip = row?.children[FILTERS.indexOf(item)] as HTMLElement | undefined
							chip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" })
						}}
					>
						{t(item.label)}
					</Chip>
				))}
			</div>
			{scanning || (engine && !engine.done) ? (
				<div className="global-search-progress">
					<WavyProgress className="global-search-wavy" label={t("searchIndexing")} />
					<span>{t("searchIndexing")} · {engine ? engine.scanned : 0}</span>
				</div>
			) : null}
			<div className="global-search-results">
				{chats.length > 0 ? (
					<section>
						<h3 className="global-search-heading">{t("searchChatsHeading")}</h3>
						{chats.map((conversation) => (
							<button key={conversation.id} type="button" className="search-row" onClick={() => props.onOpenConversation(conversation.id)}>
								<Avatar src={conversation.avatar || conversation.peer?.avatar} label={props.titleOf(conversation)} seed={conversation.peer?.id ?? conversation.id} size={40} shape={conversation.kind === "group" ? "group" : conversation.kind === "channel" ? "channel" : "circle"} />
								<span className="search-row-text">
									<span className="search-row-title">{props.titleOf(conversation)}{conversation.peer?.isBot ? <span className="bot-badge"><IBot size={12} /> BOT</span> : null}</span>
									<span className="search-row-sub">{conversation.peer ? "@" + conversation.peer.username : conversation.kind === "channel" ? t("kindChannel") : t("kindGroup")}</span>
								</span>
							</button>
						))}
					</section>
				) : null}
				{strangers.length > 0 ? (
					<section>
						<h3 className="global-search-heading">{t("searchPeopleHeading")}</h3>
						{strangers.map((person) => (
							<button key={person.id} type="button" className="search-row" onClick={() => props.onStartChat(person)}>
								<Avatar src={person.avatar} label={person.displayName || person.username} seed={person.id} size={40} />
								<span className="search-row-text">
									<span className="search-row-title">{person.displayName || person.username}{person.isBot ? <span className="bot-badge"><IBot size={12} /> BOT</span> : null}</span>
									<span className="search-row-sub">@{person.username} · {person.isBot ? t("botStart") : t("addFriend")}</span>
								</span>
							</button>
						))}
					</section>
				) : null}
				{messages.length > 0 ? (
					<section>
						<h3 className="global-search-heading">{t("searchMessagesHeading")}</h3>
						{messages.map((item) => {
							const conversation = convById.get(item.conversationId)
							const cut = snippet(item.text, query)
							return (
								<button key={item.id} type="button" className="search-row message" onClick={() => props.onOpenMessage(item.conversationId, item.id)}>
									<Avatar src={conversation?.avatar || conversation?.peer?.avatar} label={conversation ? props.titleOf(conversation) : "?"} seed={conversation?.peer?.id ?? item.conversationId} size={40} shape={conversation?.kind === "group" ? "group" : conversation?.kind === "channel" ? "channel" : "circle"} />
									<span className="search-row-text">
										<span className="search-row-title">
											<span className="grow">{conversation ? props.titleOf(conversation) : t("unknownChat")}</span>
											<span className="search-row-date">{formatDateTime(lang, item.createdAt, { day: "numeric", month: "short" })}</span>
										</span>
										<span className="search-row-sub">
											<span className="search-row-author">{props.nameOf(item.senderId)}: </span>
											{kindIcon(item.kind) ? <span className="search-kind">{kindIcon(item.kind)}</span> : null}
											{cut ? <>{cut.before}<mark>{cut.match}</mark>{cut.after}</> : item.text || t("kind_" + item.kind as StringKey)}
										</span>
									</span>
								</button>
							)
						})}
					</section>
				) : null}
				{nothing && (query || filter !== "all") && !scanning && (!engine || engine.done) ? (
					<div className="global-search-empty">
						<span className="global-search-empty-art" aria-hidden="true">
							<MorphBlob size={140} shapes={[4, 2, 6]} />
							<ISearch size={40} className="global-search-empty-icon" />
						</span>
						<p>{t("searchNothing")}</p>
					</div>
				) : null}
				{nothing && scanning ? <div className="global-search-wait"><LoadingIndicator size={40} /></div> : null}
			</div>
		</div>
	)
}
