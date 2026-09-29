import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react"
import { onOpenConversation } from "../lib/native"
import { useAuth } from "../state/auth"
import { api } from "../lib/api"
import { connectRealtime } from "../lib/ws"
import { playMessageSound, startRingtone, stopRingtone } from "../lib/sound"
import { isSealedMessage } from "../lib/keyvault"
import { activeKeyring, KeyUnavailableError, type Keyring } from "../lib/keyring"
import { accountKey, adoptLegacyPreference } from "../lib/session"
import type { BotCommand, Conversation, ConversationFolder, ConversationMember, DisplayMessage, LinkRequestInfo, MemberRole, MessageEnvelope, PinnedMessage, Reaction, PollSummary, SendOptions, Sticker, WsEvent } from "../lib/types"
import { ConversationList } from "../components/ConversationList"
import { MessageThread } from "../components/MessageThread"
import { Composer, MAX_ATTACHMENT_MB } from "../components/Composer"
import type { ComposerDraft } from "../components/Composer"
import { useCall } from "../lib/useCall"
import { CallBar, IncomingCallBanner } from "../components/CallBar"
import { encodeMediaMessage, guessMime, isVideoMedia, packFileFromBlob, packImage, parseMediaMessage, unpackFileToBlob, unpackImage, type MediaEnvelope } from "../lib/media"
import { captureVideoPoster } from "../lib/videothumb"
import { voiceExtension, type VoiceRecording } from "../lib/voice"
import { encodePollMessage, parsePollMessage } from "../lib/poll"
import { mentionsUser, stripFormatting } from "../lib/richtext"
import { encodeLinkMessage, firstUrl, parseLinkMessage, shrinkPreviewImage, type LinkPreviewCard } from "../lib/linkmsg"
import { parseButtonMessage, sanitizeButtons, type BotButton } from "../lib/botmsg"
import { encodeContact, encodeLocation, parseContact, parseLocation, type ContactPayload, type LocationPayload } from "../lib/richmsg"
import { isOfflineFailure, loadOutbox, newOutboxItem, saveOutbox, type OutboxItem } from "../lib/outbox"
import { buildExportHtml, downloadTextFile, safeFileName, type ExportMessage } from "../lib/exportchat"
import { PollDialog, type PollDraftInput } from "../components/PollDialog"

export type UploadStage = "encrypt" | "upload"

export type PendingUpload = {
	id: string
	conversationId: string
	name: string
	size: number
	stage: UploadStage
	progress: number
	poster: string | null
}

function ttlLabel(seconds: number, t: (key: any) => string): string {
	if (seconds <= 3600) return t("ttl1h")
	if (seconds <= 86400) return t("ttl1d")
	if (seconds <= 604800) return t("ttl1w")
	return t("ttl30d")
}

const mediaUrlCache = new Map<string, string>()
// Opened message bodies, so a re-render does not decrypt the whole chat again.
const plainCache = new Map<string, string>()

async function resolveMediaUrl(media: MediaEnvelope, onProgress?: (ratio: number) => void): Promise<string | null> {
	const cached = mediaUrlCache.get(media.fileId)
	if (cached) return cached
	const cipher = await api.downloadFileBlob(media.fileId, onProgress)
	const blob = await unpackFileToBlob(media, cipher)
	const url = URL.createObjectURL(blob)
	mediaUrlCache.set(media.fileId, url)
	return url
}
import { FolderDialog } from "../components/FolderDialog"
import { GalleryDialog } from "../components/GalleryDialog"
import { PinnedDialog } from "../components/PinnedDialog"
import { MediaViewer, type ViewerItem } from "../components/MediaViewer"
import { FolderTabs } from "../components/FolderTabs"
import { NewConversationDialog } from "../components/NewConversationDialog"
import { MemberDialog } from "../components/MemberDialog"
import { SettingsSheet, type SettingsPageId } from "../components/settings/SettingsSheet"
import { SignOutSheet } from "../components/settings/SignOutSheet"
import { ChoiceSheet } from "../components/settings/common"
import { GlobalSearch } from "../components/GlobalSearch"
import { KeyUnlockSheet } from "../components/KeyUnlockSheet"
import { LinkApprovalSheet } from "../components/LinkApprovalSheet"
import { ScheduledSheet } from "../components/ScheduledSheet"
import { SafetySheet } from "../components/SafetySheet"
import { Avatar, Badge, Banner, Button, IconButton, ListGroup, ListItem, Menu, Sheet, SwitchItem, type MenuItemSpec } from "../components/m3"
import { IAdd, IBell, IBellOff, IBot, IClock, IClose, IDownload, IGallery, IKey, ILock, ILogout, IMore, IPeople, IPin, ISchedule, ISearch, ISettingsGear, IShield, IStorage, ISwap, ITrash, IPhoneCall, IChat } from "../components/m3icons"
import { SearchEngine } from "../lib/search"
import { useBackgroundAccounts } from "../lib/backgroundAccounts"
import { syncWebPush } from "../lib/webpush"
import { MAX_ACCOUNTS, setActiveAccountId } from "../lib/session"
import { FriendRequestsDialog } from "../components/FriendRequestsDialog"
import { ForwardDialog } from "../components/ForwardDialog"
import { CommentsDialog, type CommentItem } from "../components/CommentsDialog"
import { BrandLogo } from "../components/BrandLogo"
import { useSettings } from "../state/settings"
import { formatLastSeen, getActiveLang, translate, type StringKey } from "../lib/i18n"
import { errorText } from "../lib/errorText"
import { MorphBlob } from "../components/Expressive"

import { pushToast, setToastOpenHandler } from "../lib/toasts"

function isPhoneViewport(): boolean { return typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches }

async function toastBody(message: any, fallback: string, mediaLabel: string, pollLabel: string, voiceLabel: string): Promise<string> {
	const ring = activeKeyring()
	if (!ring) return fallback
	try {
		const text = await ring.decrypt(message.conversationId, message.ciphertext)
		const media = parseMediaMessage(text)
		if (media) return media.kind === "voice" ? voiceLabel : mediaLabel
		if (parsePollMessage(text)) return pollLabel
		const buttons = parseButtonMessage(text)
		const link = parseLinkMessage(text)
		const trimmed = stripFormatting(buttons ? buttons.text : link ? link.text : text).trim()
		if (!trimmed) return fallback
		return trimmed.length > 140 ? trimmed.slice(0, 140) : trimmed
	} catch {
		return fallback
	}
}

const errMessage = errorText
// Module-level helpers and memoized callbacks read the current language
// directly, so a language switch never leaves them with stale text.
const tt = (key: StringKey): string => translate(getActiveLang(), key)

// The keyring of the signed-in account; Chat only renders once keys are ready.
function ring(): Keyring {
	const current = activeKeyring()
	if (!current) throw new Error(tt("encryptionKeyMissing"))
	return current
}

const PAGE_SIZE = 50
const TYPING_TTL_MS = 5000
const PINNED_CHATS_KEY = "frontierx.pinnedChats"
const MUTE_FOREVER_MS = 1000 * 60 * 60 * 24 * 365 * 100


function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
	const comma = dataUrl.indexOf(",")
	const header = comma >= 0 ? dataUrl.slice(0, comma) : ""
	const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
	const match = header.match(/data:([^;]+)/)
	const mime = match ? match[1] : "application/octet-stream"
	const binary = atob(body)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
	return { bytes, mime }
}

// Which folder tab the sidebar shows, and how wide the sidebar is, are
// per-device layout choices, so they live in local storage rather than on the
// server (folders themselves are stored per account).
const ACTIVE_FOLDER_KEY = "frontierx.activeFolder"
const SIDEBAR_WIDTH_KEY = "frontierx.sidebarWidth"
const SIDEBAR_WIDTH_DEFAULT = 320
const SIDEBAR_WIDTH_MIN = 240
const SIDEBAR_WIDTH_MAX = 560

function clampSidebarWidth(value: number): number {
	if (!Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT
	return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(value)))
}

function loadSidebarWidth(): number {
	try {
		const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
		if (!raw) return SIDEBAR_WIDTH_DEFAULT
		return clampSidebarWidth(Number(raw))
	} catch {
		return SIDEBAR_WIDTH_DEFAULT
	}
}

function loadActiveFolder(): string | null {
	try {
		adoptLegacyPreference(ACTIVE_FOLDER_KEY)
		return window.localStorage.getItem(accountKey(ACTIVE_FOLDER_KEY))
	} catch {
		return null
	}
}

function loadPinnedChats(): string[] {
	try {
		adoptLegacyPreference(PINNED_CHATS_KEY)
		const raw = window.localStorage.getItem(accountKey(PINNED_CHATS_KEY))
		if (!raw) return []
		const parsed = JSON.parse(raw) as unknown
		return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []
	} catch {
		return []
	}
}

export function Chat() {
	const { user, token, updateUser, keys, keyring, accounts, switchAccount, revalidateKeys } = useAuth()
	const { t, lang } = useSettings()
	// A chat to open at a given message (from search or a notification).
	const pendingJumpRef = useRef<{ conversationId: string; messageId: string } | null>(null)
	const [hasNewer, setHasNewer] = useState(false)
	const [loadingNewer, setLoadingNewer] = useState(false)
	const hasNewerRef = useRef(false)
	hasNewerRef.current = hasNewer
	const [scheduledVersion, setScheduledVersion] = useState(0)
	const [showScheduled, setShowScheduled] = useState(false)
	const [globalQuery, setGlobalQuery] = useState("")
	const [globalOpen, setGlobalOpen] = useState(false)
	const [unlockOpen, setUnlockOpen] = useState(false)
	const [linkRequest, setLinkRequest] = useState<LinkRequestInfo | null>(null)
	const [settingsPage, setSettingsPage] = useState<SettingsPageId | null>(null)
	const [accountMenu, setAccountMenu] = useState<HTMLElement | null>(null)
	const [headerMenu, setHeaderMenu] = useState<HTMLElement | null>(null)
	// The menu of a chat in the list (right click / long press), and an action
	// picked there for a chat that first has to be opened.
	const [chatMenu, setChatMenu] = useState<{ conversation: Conversation; x: number; y: number } | null>(null)
	const [pendingChatAction, setPendingChatAction] = useState<{ id: string; key: string } | null>(null)
	const headerMenuItemsRef = useRef<MenuItemSpec[]>([])
	const [choice, setChoice] = useState<"mute" | "ttl" | "folders" | null>(null)
	const [showThreadSearch, setShowThreadSearch] = useState(false)
	const [safetyOpen, setSafetyOpen] = useState(false)
	const [signOutOpen, setSignOutOpen] = useState(false)
	const [botCommands, setBotCommands] = useState<BotCommand[]>([])
	const backgroundUnread = useBackgroundAccounts(accounts, user?.id ?? null, (account) => {
		pushToast({ title: account.displayName || account.username, body: t("notifOtherAccount") })
	})
	const searchEngine = useMemo(() => (keyring ? new SearchEngine(keyring) : null), [keyring])
	const searchEngineRef = useRef<SearchEngine | null>(null)
	searchEngineRef.current = searchEngine
	const [conversations, setConversations] = useState<Conversation[]>([])
	const [activeId, setActiveId] = useState<string | null>(null)
	const [rawMessages, setRawMessages] = useState<MessageEnvelope[]>([])
	const [display, setDisplay] = useState<DisplayMessage[]>([])
	// Whether messages can be sealed in the open chat right now, and a counter
	// bumped whenever the keyring learns a key, so locked bubbles re-open.
	const [keyReady, setKeyReady] = useState(false)
	const [keyPending, setKeyPending] = useState(false)
	const [keyVersion, setKeyVersion] = useState(0)
	const [showNew, setShowNew] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [loadingMessages, setLoadingMessages] = useState(false)
	const [loadingOlder, setLoadingOlder] = useState(false)
	const [hasMore, setHasMore] = useState(false)
	const [reactions, setReactions] = useState<Reaction[]>([])
	const [pinned, setPinned] = useState<PinnedMessage[]>([])
	const [members, setMembers] = useState<ConversationMember[]>([])
	const membersRef = useRef<ConversationMember[]>([])
	membersRef.current = members
	// Button presses waiting for the bot's answer, by callback id.
	const callbackWaiters = useRef(new Map<string, () => void>())
	const [onlineUserIds, setOnlineUserIds] = useState<string[]>([])
	const [onlinePeerIds, setOnlinePeerIds] = useState<string[]>([])
	// When people were last online, for those whose settings let us see it.
	const [lastSeen, setLastSeen] = useState<Record<string, string>>({})
	// The global snapshot covers everyone we share a chat with, so it replaces
	// the map (a time that became hidden disappears); a single chat's snapshot
	// only adds to it. Live changes arrive with presence events.
	const mergeLastSeen = useCallback((next: Record<string, string> | undefined, replace = false) => {
		setLastSeen((previous) => ({ ...(replace ? {} : previous), ...(next ?? {}) }))
	}, [])
	// Relative labels ("5 minutes ago") are recomputed on this tick.
	const [clockNow, setClockNow] = useState(() => Date.now())
	useEffect(() => {
		const timer = window.setInterval(() => setClockNow(Date.now()), 30000)
		return () => window.clearInterval(timer)
	}, [])
	useEffect(() => {
		let alive = true
		const load = () => { void api.getPresence().then((res) => { if (!alive) return; setOnlinePeerIds(res.onlineUserIds); mergeLastSeen(res.lastSeen, true) }).catch(() => undefined) }
		load()
		const timer = window.setInterval(load, 30000)
		return () => { alive = false; window.clearInterval(timer) }
	}, [])
	const [showMembers, setShowMembers] = useState(false)
	const [showArchived, setShowArchived] = useState(false)
	// Attachments in flight, shown in the thread so a long send never looks like
	// a frozen chat.
	const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
	const [viewerIndex, setViewerIndex] = useState<number | null>(null)
	const [showGallery, setShowGallery] = useState(false)
	const [showPinnedList, setShowPinnedList] = useState(false)
	const [jumpToId, setJumpToId] = useState<string | null>(null)
	const [mentionChats, setMentionChats] = useState<string[]>([])
	const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null)
	const [dragOver, setDragOver] = useState(false)
	const [folders, setFolders] = useState<ConversationFolder[]>([])
	const [activeFolderId, setActiveFolderId] = useState<string | null>(() => loadActiveFolder())
	const [foldersLoaded, setFoldersLoaded] = useState(false)
	const [showFolders, setShowFolders] = useState(false)
	const [outbox, setOutbox] = useState<OutboxItem[]>(() => loadOutbox())
	const [exporting, setExporting] = useState(false)
	const [sidebarWidth, setSidebarWidth] = useState<number>(() => loadSidebarWidth())
	const [polls, setPolls] = useState<PollSummary[]>([])
	const [showPollDialog, setShowPollDialog] = useState(false)
	const [composerValue, setComposerValue] = useState("")

	// The websocket echoes our own draft saves back to us. Applying that echo while
	// the user is still typing is what made letters vanish (and deleted text come
	// back), so remember what we saved and when the last local keystroke happened.
	const lastSavedDraftRef = useRef<string | null>(null)
	const lastLocalDraftEditRef = useRef(0)
	const lastLocalDraftChatRef = useRef<string | null>(null)

	function updateComposerValue(value: string): void {
		lastLocalDraftEditRef.current = Date.now()
		lastLocalDraftChatRef.current = activeIdRef.current
		setComposerValue(value)
	}

	function typingRecently(conversationId: string | null, windowMs: number): boolean {
		if (lastLocalDraftChatRef.current !== conversationId) return false
		return Date.now() - lastLocalDraftEditRef.current < windowMs
	}
	const [draftHydratedFor, setDraftHydratedFor] = useState<string | null>(null)
	const [searchQuery, setSearchQuery] = useState("")
	const [unread, setUnread] = useState<Record<string, number>>({})
	const [typingUntil, setTypingUntil] = useState<Record<string, number>>({})
	const [typingTick, setTypingTick] = useState(0)
	const [showFriends, setShowFriends] = useState(false)
	const [friendRequestCount, setFriendRequestCount] = useState(0)
	const [inviteCode, setInviteCode] = useState<string | null>(null)
	const [confirmRemoveFriend, setConfirmRemoveFriend] = useState(false)
	const [groupInvites, setGroupInvites] = useState<{ id: string; conversationId: string; conversationTitle: string | null; conversationKind: string; fromUser: string; fromName: string | null; createdAt: string }[]>([])
	const [forwardFor, setForwardFor] = useState<DisplayMessage | null>(null)
	const [commentsFor, setCommentsFor] = useState<DisplayMessage | null>(null)
	const [comments, setComments] = useState<CommentItem[]>([])
	const [commentsLoading, setCommentsLoading] = useState(false)
	const [pinnedChats, setPinnedChats] = useState<string[]>(() => loadPinnedChats())
	const [draft, setDraft] = useState<ComposerDraft>({
		replyToId: null,
		replyToText: null,
		editingId: null,
		editingText: null,
	})
	const lastTypingSentRef = useRef(0)
	const pollDialogOpenerRef = useRef<HTMLElement | null>(null)

	const activeIdRef = useRef<string | null>(null)
	activeIdRef.current = activeId

	useEffect(() => {
		if (!activeId) return
		setMentionChats((prev) => prev.includes(activeId) ? prev.filter((id) => id !== activeId) : prev)
	}, [activeId])

	const currentUserId = user?.id ?? ""
	const call = useCall(currentUserId, t("callRefused"))
	const [readIds, setReadIds] = useState(new Set() as any)
	const sentReceiptsRef = useRef(new Set() as any)
	useEffect(() => {
		if (!activeId) {
			setReadIds(new Set())
			sentReceiptsRef.current = new Set()
			return
		}
		let cancelled = false
		void api.listReceipts(activeId).then((res: any) => {
			if (cancelled) return
			const next = new Set()
			for (const entry of res.receipts) {
				if (entry.state === "read") next.add(entry.messageId)
			}
			setReadIds(next)
		}).catch(() => undefined)
		return () => {
			cancelled = true
		}
	}, [activeId, currentUserId])
	useEffect(() => {
		if (!activeId) return
		const target = activeId
		const pending = rawMessages.filter((m) => m.conversationId === target && m.senderId !== currentUserId && !sentReceiptsRef.current.has(m.id))
		if (pending.length === 0) return
		for (const m of pending) {
			sentReceiptsRef.current.add(m.id)
			void api.sendReceipt(target, { messageId: m.id, state: "read" }).catch(() => undefined)
		}
		setReadIds((prev: any) => { const next = new Set(prev); for (const m of pending) next.add(m.id); return next })
	}, [activeId, rawMessages, currentUserId])
	const callHandleRef = useRef(call.handleEvent)
	callHandleRef.current = call.handleEvent
	const conversationsRef = useRef(conversations)
	conversationsRef.current = conversations
	const refreshPolls = useCallback(async (conversationId: string) => { const result=await api.listPolls(conversationId); setPolls(result.polls) }, [])

	const convTitle = useCallback((conversation: Conversation): string => {
		if (conversation.isSelf) return t("savedMessages")
		if (conversation.title && conversation.kind !== "direct") return conversation.title
		if (conversation.kind === "direct") return conversation.peer ? (conversation.peer.displayName || conversation.peer.username) : (conversation.title || t("directConversation"))
		return conversation.kind === "channel" ? t("kindChannel") : t("kindGroup")
	}, [t])

	const refreshFolders = useCallback(async () => {
		const result = await api.listConversationFolders()
		setFolders(result.folders)
		setFoldersLoaded(true)
	}, [])

	useEffect(() => {
		void refreshFolders().catch(() => undefined)
	}, [refreshFolders])

	// A folder deleted here or on another device must not keep filtering the list.
	// Checked only once the folders have actually arrived, otherwise the empty
	// first render would drop the tab restored from local storage.
	useEffect(() => {
		if (!foldersLoaded) return
		if (activeFolderId && !folders.some((folder) => folder.id === activeFolderId)) setActiveFolderId(null)
	}, [folders, activeFolderId, foldersLoaded])

	useEffect(() => {
		if (!foldersLoaded) return
		try {
			if (activeFolderId) window.localStorage.setItem(accountKey(ACTIVE_FOLDER_KEY), activeFolderId)
			else window.localStorage.removeItem(accountKey(ACTIVE_FOLDER_KEY))
		} catch {
			// Storage can be unavailable; the choice then lasts for this session.
		}
	}, [activeFolderId, foldersLoaded])

	useEffect(() => {
		try {
			window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
		} catch {
			// Same: the width still applies until the page is reloaded.
		}
	}, [sidebarWidth])

	const handleSetTtl = useCallback(async (seconds: number | null) => {
		const conversationId = activeIdRef.current
		if (!conversationId) return
		setError(null)
		try {
			const res = await api.setConversationTtl(conversationId, seconds)
			setConversations((prev) => prev.map((item) => item.id === conversationId ? { ...item, ttlSeconds: res.ttlSeconds } : item))
		} catch (err) {
			setError(errMessage(err, t("ttlFailed")))
		}
	}, [t])

	const handleToggleChatFolder = useCallback(async (folderId: string, conversationId: string, active: boolean) => {
		setError(null)
		try {
			await api.setFolderConversation(folderId, conversationId, active)
			await refreshFolders()
		} catch (err) {
			setError(errMessage(err, t("folderActionFailed")))
		}
	}, [refreshFolders, t])

	useEffect(() => {
		let active = true
		api
			.listConversations()
			.then((res) => {
				if (!active) return
				setConversations(res.conversations)
				setActiveId((prev) => prev ?? res.conversations.find((conversation) => !conversation.archivedAt)?.id ?? res.conversations[0]?.id ?? null)
				void api.listFriendRequests().then((r) => setFriendRequestCount(r.incoming.length)).catch(() => {})
				void api.listGroupInvites().then((r) => setGroupInvites(r.invites)).catch(() => {})
				let pendingInvite: string | null = null
				try { pendingInvite = window.localStorage.getItem("pendingInvite") } catch { pendingInvite = null }
				if (pendingInvite) {
					try { window.localStorage.removeItem("pendingInvite") } catch { /* ignore */ }
					setInviteCode(pendingInvite)
				}
			})
			.catch((err) => {
				if (active) setError(errMessage(err, tt("loadConversationsFailed")))
			})
		return () => {
			active = false
		}
	}, [])

	// Keys of the open chat. A key that is still on its way (another member's
	// device hands it over) keeps the composer waiting; everything that arrives
	// re-opens the locked bubbles through keyVersion.
	useEffect(() => {
		if (!activeId) {
			setKeyReady(false)
			setKeyPending(false)
			return
		}
		let active = true
		const conversationId = activeId
		const keyring = activeKeyring()
		if (!keyring) return
		setKeyReady(false)
		setKeyPending(false)
		const refresh = () => {
			const status = keyring.status(conversationId)
			setKeyReady(status === "ready")
			setKeyPending(status === "pending")
		}
		const unsubscribe = keyring.subscribe((changed) => {
			if (!active) return
			setKeyVersion((value) => value + 1)
			if (changed === conversationId) refresh()
		})
		void keyring
			.load(conversationId, true)
			.then(() => {
				if (active) refresh()
			})
			.catch((err) => {
				if (active) setError(errMessage(err, t("encryptionSetupFailed")))
			})
		// A pending key is asked for again now and then until it arrives.
		const timer = window.setInterval(() => {
			if (!active || keyring.status(conversationId) !== "pending") return
			void keyring.load(conversationId, true).then(refresh).catch(() => undefined)
		}, 15000)
		return () => {
			active = false
			unsubscribe()
			window.clearInterval(timer)
		}
	}, [activeId, keyring])

	useEffect(() => {
		if (!activeId) {
			setRawMessages([])
			setComposerValue("")
			setDraftHydratedFor(null)
			setSearchQuery("")
			return
		}
		let active = true
		const conversationId = activeId
		setLoadingMessages(true)
		setReactions([])
		setPinned([])
		setPolls([])
		setShowPollDialog(false)
		setMembers([])
		setOnlineUserIds([])
		setShowMembers(false)
		setComposerValue("")
		setDraftHydratedFor(null)
		setSearchQuery("")
		setDraft({ replyToId: null, replyToText: null, editingId: null, editingText: null })
		setUnread((prev) => {
			const next = { ...prev }
			next[conversationId] = 0
			return next
		})
		setHasNewer(false)
		const jump = pendingJumpRef.current && pendingJumpRef.current.conversationId === conversationId ? pendingJumpRef.current : null
		pendingJumpRef.current = null
		const loadPage = jump ? api.messagesAround(conversationId, jump.messageId, PAGE_SIZE) : api.listMessages(conversationId, { limit: PAGE_SIZE })
		loadPage
			.then((res) => {
				if (!active) return
				setRawMessages(res.messages)
				setHasMore(res.hasMore)
				setHasNewer(Boolean(res.hasNewer))
				if (jump) window.setTimeout(() => setJumpToId(jump.messageId), 60)
			})
			.catch((err) => {
				if (active) setError(errMessage(err, tt("loadMessagesFailed")))
			})
			.finally(() => {
				if (active) setLoadingMessages(false)
			})
		api
			.listReactions(conversationId)
			.then((res) => { if (active) setReactions(res.reactions) })
			.catch(() => undefined)
		api
			.listPinnedMessages(conversationId)
			.then((res) => { if (active) setPinned(res.pinned) })
			.catch((err) => { if (active) setError(errMessage(err, tt("loadPinnedFailed"))) })
		api
			.listPolls(conversationId)
			.then((res) => { if (active) setPolls(res.polls) })
			.catch((err) => { if (active) setError(errMessage(err, tt("loadPollsFailed"))) })
		api
			.getConversationMembers(conversationId)
			.then((res) => { if (active) setMembers(res.members) })
			.catch((err) => { if (active) setError(errMessage(err, tt("loadMembersFailed"))) })
		api
			.getConversationPresence(conversationId)
			.then((res) => { if (!active) return; setOnlineUserIds(res.onlineUserIds); mergeLastSeen(res.lastSeen) })
			.catch((err) => { if (active) setError(errMessage(err, tt("loadPresenceFailed"))) })
		return () => {
			active = false
		}
	}, [activeId])

	useEffect(() => {
		if (!activeId || !keyReady) return
		let active = true
		const conversationId = activeId
		void api.getConversationDraft(conversationId).then(async (res) => {
			let plaintext = ""
			if (res.draft?.ciphertext) {
				try {
					plaintext = await ring().decrypt(conversationId, res.draft.ciphertext)
				} catch {
					// a draft sealed with a key this device cannot open yet
					plaintext = ""
				}
			}
			if (active && !typingRecently(conversationId, 2000)) {
				setComposerValue(plaintext)
				setDraftHydratedFor(conversationId)
			}
		}).catch((err) => { if (active) setError(errMessage(err, tt("loadDraftFailed"))) })
		return () => { active = false }
	}, [activeId, keyReady])

	useEffect(() => {
		if (!activeId || !keyReady || draftHydratedFor !== activeId || draft.editingId) return
		const conversationId = activeId
		const timer = window.setTimeout(() => {
			void (async () => {
				try {
					const ciphertext = composerValue.trim() ? await ring().encrypt(conversationId, composerValue) : null
					await api.saveConversationDraft(conversationId, ciphertext)
					lastSavedDraftRef.current = composerValue
				} catch (err) { setError(errMessage(err, tt("saveDraftFailed"))) }
			})()
		}, 550)
		return () => window.clearTimeout(timer)
	}, [activeId, keyReady, composerValue, draft.editingId, draftHydratedFor])

	useEffect(() => {
		return onOpenConversation((conversationId) => setActiveId(conversationId))
	}, [])

	useEffect(() => {
		if (!token) return
		setToastOpenHandler((id: string) => setActiveId(id))
		const handle = connectRealtime(token, (event: WsEvent) => {
			if (
				event.type === "call.invite" ||
				event.type === "call.participants" ||
				event.type === "call.joined" ||
				event.type === "call.left" ||
				event.type === "call.ended" ||
				event.type === "call.signal"
			) {
				callHandleRef.current(event)
				return
			}
			
			if (event.type === "presence.updated") {
				if (event.lastSeenAt !== undefined) {
					setLastSeen((previous) => {
						const next = { ...previous }
						if (event.lastSeenAt) next[event.userId] = event.lastSeenAt
						else delete next[event.userId]
						return next
					})
				}
				setOnlinePeerIds((previous) => {
					if (event.online) return previous.includes(event.userId) ? previous : previous.concat(event.userId)
					return previous.filter((userId) => userId !== event.userId)
				})
				if (event.conversationId !== activeIdRef.current) return
				setOnlineUserIds((previous) => {
					if (event.online) return previous.includes(event.userId) ? previous : previous.concat(event.userId)
					return previous.filter((userId) => userId !== event.userId)
				})
				return
			}
			if (event.type === "bot.callback_answer") {
				const waiting = callbackWaiters.current.get(event.callbackId)
				callbackWaiters.current.delete(event.callbackId)
				waiting?.()
				if (event.text) {
					const botName = membersRef.current.find((m) => m.userId === event.botId)?.displayName ?? "FrontierX"
					void (async () => {
						let text = t("messageEncrypted")
						try {
							text = stripFormatting(await ring().decrypt(event.conversationId, event.text as string))
						} catch {
							// shown as an encrypted notice
						}
						if (event.alert) window.alert(text)
						else pushToast({ title: botName, body: text.slice(0, 300) })
					})()
				}
				return
			}
			if (event.type === "conversation.muted") { if(event.userId===currentUserId) setConversations((prev)=>prev.map((c)=>c.id===event.conversationId?{...c,mutedUntil:event.mutedUntil}:c)); return }
			if (event.type === "friend.request") { void api.listFriendRequests().then((r) => setFriendRequestCount(r.incoming.length)).catch(() => {}); return }
			if (event.type === "group.invite") { setGroupInvites((prev) => prev.some((gi) => gi.id === event.invite.id) ? prev : [event.invite, ...prev]); return }
			if (event.type === "friend.accepted") { setConversations((prev)=>prev.some((c)=>c.id===event.conversation.id)?prev:[event.conversation,...prev]); setActiveId(event.conversation.id); return }
			if (event.type === "friend.removed") { setConversations((prev)=>prev.filter((c)=>c.id!==event.conversationId)); if (activeIdRef.current === event.conversationId) setActiveId(null); if (event.by !== currentUserId) window.alert(t("youWereRemoved")); return }
			if (event.type === "conversation.added") { setConversations((prev)=>prev.some((c)=>c.id===event.conversation.id)?prev:[event.conversation,...prev]); return }
			if (event.type === "conversation.deleted") { setConversations((prev)=>prev.filter((c)=>c.id!==event.conversationId)); if (activeIdRef.current === event.conversationId) setActiveId(null); return }
			if (event.type === "member.added" || event.type === "member.removed") {
				activeKeyring()?.onMembershipChanged(event.conversationId)
				if (event.conversationId === activeIdRef.current) void api.getConversationMembers(event.conversationId).then((res) => setMembers(res.members)).catch(() => undefined)
				return
			}
			if (event.type === "keys.shares_needed") { activeKeyring()?.onSharesNeeded(event.conversationId); return }
			if (event.type === "keys.link_requested") { if (activeKeyring()) setLinkRequest(event.request); return }
			if (event.type === "keys.link_resolved") { setLinkRequest((current) => (current && current.id === event.id ? null : current)); return }
			if (event.type === "keys.account_reset") { void revalidateKeys(); return }
			if (event.type === "keys.shares_added") { activeKeyring()?.onSharesAdded(event.conversationId); return }
			if (event.type === "keys.epoch_created") { activeKeyring()?.onEpochCreated(event.conversationId, event.keyId); return }
			if (event.type === "scheduled.updated") { setConversations((prev) => prev.map((c) => c.id === event.conversationId ? { ...c, scheduledCount: event.count } : c)); if (event.conversationId === activeIdRef.current) setScheduledVersion((value) => value + 1); return }
			if (event.type === "conversation.profile_updated") { setConversations((prev)=>prev.map((c)=>c.id===event.conversationId?{...c,title:event.title,avatar:event.avatar}:c)); return }
			if (event.type === "user.profile_updated") { setMembers((prev)=>prev.map((m)=>m.userId===event.userId?{...m,displayName:event.displayName,avatar:event.avatar}:m)); setConversations((prev)=>prev.map((c)=>c.peer&&c.peer.id===event.userId?{...c,peer:{...c.peer,displayName:event.displayName,avatar:event.avatar}}:c)); return }
			if (event.type === "poll.updated") { if(event.conversationId!==activeIdRef.current) return; setPolls((previous)=>{ const known=previous.some((poll)=>poll.messageId===event.update.messageId); if(!known) { void refreshPolls(event.conversationId).catch(()=>undefined); return previous } return previous.map((poll)=>poll.messageId===event.update.messageId?{...poll,optionCounts:event.update.optionCounts,totalVoters:event.update.totalVoters,closedAt:event.update.closedAt}:poll) }); return }
			if (event.type === "receipt.updated") {
				if (event.state !== "read") return
				const readMessageId = event.messageId
				setReadIds((prev: any) => {
					if (prev.has(readMessageId)) return prev
					const next = new Set(prev)
					next.add(readMessageId)
					return next
				})
				return
			}
			if (event.type === "message.created") {
				const message = event.message
				// A message that names you is worth marking even in a busy chat.
				if (message.senderId !== currentUserId && message.conversationId !== activeIdRef.current && user?.username) {
					const keyring = activeKeyring()
					if (keyring) {
						void keyring.decrypt(message.conversationId, message.ciphertext)
							.then((text) => {
								if (!parseMediaMessage(text) && mentionsUser(text, user.username)) {
									setMentionChats((prev) => prev.includes(message.conversationId) ? prev : prev.concat([message.conversationId]))
								}
							})
							.catch(() => undefined)
					}
				}
				if (message.senderId !== currentUserId) {
					const conv = conversationsRef.current.find((item) => item.id === message.conversationId)
					const chatMuted = Boolean(message.silent) || Boolean(conv && conv.mutedUntil && new Date(conv.mutedUntil).getTime() > Date.now())
					if (!chatMuted) playMessageSound()
					if (!chatMuted && (message.conversationId !== activeIdRef.current || document.hidden)) {
						const cv: any = conv
						const title = (cv && cv.title) || (cv && cv.peer && (cv.peer.displayName || cv.peer.username)) || t("notifNewMessage")
						if (!isPhoneViewport()) void toastBody(message, t("messageEncrypted"), t("notifAttachment"), t("notifPoll"), t("voiceMessage")).then((body) => pushToast({ title, body, conversationId: message.conversationId }))
					}
				}
				void searchEngineRef.current?.addLive(message)
				if (message.conversationId !== activeIdRef.current) {
					setUnread((prev) => {
						const next = { ...prev }
						next[message.conversationId] = (next[message.conversationId] ?? 0) + 1
						return next
					})
					return
				}
				if (hasNewerRef.current) return
				setRawMessages((prev) => {
					if (prev.some((m) => m.id === message.id)) return prev
					return [...prev, message]
				})
				return
			}
			if (event.type === "message.updated") {
				const updated = event.message
				if (updated.conversationId !== activeIdRef.current) return
				setRawMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
				return
			}
			if (event.type === "message.deleted") {
				if (event.conversationId !== activeIdRef.current) return
				const removedId = event.messageId
				const at = new Date().toISOString()
				setRawMessages((prev) =>
					prev.map((m) => (m.id === removedId ? { ...m, ciphertext: "", deletedAt: at } : m)),
				)
				setPinned((prev) => prev.filter((item) => item.messageId !== removedId))
				setPolls((prev) => prev.filter((poll) => poll.messageId !== removedId))
				return
			}
			if (event.type === "typing") {
				if (event.conversationId !== activeIdRef.current) return
				const who = event.userId
				setTypingUntil((prev) => {
					const next = { ...prev }
					next[who] = Date.now() + TYPING_TTL_MS
					return next
				})
				return
			}
			if (event.type === "reaction.updated") {
				if (event.conversationId !== activeIdRef.current) return
				const changed = event
				setReactions((prev) => {
					const rest = prev.filter(
						(r) =>
							r.messageId !== changed.messageId ||
							r.userId !== changed.userId ||
							r.emoji !== changed.emoji,
					)
					if (!changed.active) return rest
					return rest.concat([
						{
							messageId: changed.messageId,
							userId: changed.userId,
							emoji: changed.emoji,
							at: new Date().toISOString(),
						},
					])
				})
				return
			}
			if (event.type === "message.pinned") {
				if (event.conversationId !== activeIdRef.current) return
				setPinned((prev) => {
					const rest = prev.filter((item) => item.messageId !== event.messageId)
					return event.active && event.pinnedAt ? rest.concat([{ conversationId: event.conversationId, messageId: event.messageId, pinnedBy: event.pinnedBy, pinnedAt: event.pinnedAt }]) : rest
				})
				return
			}
			if (event.type === "member.role_changed") {
				if (event.conversationId !== activeIdRef.current) return
				setMembers((prev) => prev.map((member) => member.userId === event.userId ? { ...member, role: event.role } : member))
				return
			}
			if (event.type === "folder.updated") {
				if (event.userId !== currentUserId) return
				void refreshFolders().catch(() => undefined)
				return
			}
			if (event.type === "conversation.ttl_changed") {
				setConversations((prev) => prev.map((item) => item.id === event.conversationId ? { ...item, ttlSeconds: event.ttlSeconds } : item))
				return
			}
			if (event.type === "conversation.state_changed") {
				if (event.userId !== currentUserId) return
				setConversations((prev) => prev.map((conversation) => conversation.id === event.conversationId ? { ...conversation, archivedAt: event.archivedAt } : conversation))
				return
			}
			if (event.type === "draft.updated") {
				if (event.conversationId !== activeIdRef.current || event.userId !== currentUserId || draft.editingId || !keyReady) return
				void (async () => {
					try {
						const incoming = event.ciphertext ? await ring().decrypt(event.conversationId, event.ciphertext) : ""
						// Our own save echoed back, or the user is still typing: keep the field.
						if (incoming === lastSavedDraftRef.current) return
						if (typingRecently(event.conversationId, 6000)) return
						setComposerValue(incoming)
						setDraftHydratedFor(event.conversationId)
					} catch {}
				})()
				return
			}
			if (event.type === "ready") {
				const current = activeIdRef.current
				void activeKeyring()?.syncPending().catch(() => undefined)
				if (!current || hasNewerRef.current) return
				void api.getConversationPresence(current).then((res) => { setOnlineUserIds(res.onlineUserIds); mergeLastSeen(res.lastSeen) }).catch(() => undefined)
				void api
					.listMessages(current, { limit: PAGE_SIZE })
					.then((res) => {
						setRawMessages(res.messages)
						setHasMore(res.hasMore)
					})
					.catch(() => undefined)
			}
		})
		return () => handle.close()
	}, [token, keyReady, draft.editingId, currentUserId, refreshPolls, refreshFolders])

	useEffect(() => {
		if (!call.incoming) return
		startRingtone()
		return () => stopRingtone()
	}, [call.incoming])

	useEffect(() => {
		if (!activeId) {
			setDisplay([])
			return
		}
		let active = true
		const keyring = activeKeyring()
		;(async () => {
			const next: DisplayMessage[] = []
			for (const message of rawMessages) {
				let text: string | null = null
				let locked = false
				if (!isSealedMessage(message.ciphertext)) {
					text = message.ciphertext
				} else {
					const cacheKey = message.id + ":" + message.ciphertext.length + ":" + message.ciphertext.slice(-24)
					const cached = plainCache.get(cacheKey)
					if (cached !== undefined) text = cached
					else if (keyring) {
						try {
							text = await keyring.decryptCached(message.conversationId, message.ciphertext)
							plainCache.set(cacheKey, text)
						} catch {
							locked = true
						}
					} else {
						locked = true
					}
				}
				const buttonMessage = parseButtonMessage(text)
				const link = buttonMessage ? null : parseLinkMessage(text)
				const media = parseMediaMessage(text)
				next.push({
					id: message.id,
					conversationId: message.conversationId,
					senderId: message.senderId,
					createdAt: message.createdAt,
					replyTo: message.replyTo ?? null,
					text: buttonMessage ? buttonMessage.text : link ? link.text : text,
					locked: locked && !message.deletedAt,
					editedAt: message.editedAt ?? null,
					deleted: Boolean(message.deletedAt),
					media,
					poll: parsePollMessage(text),
					link: link ? link.preview : null,
					location: parseLocation(text),
					contact: parseContact(text),
					silent: Boolean(message.silent),
					buttons: buttonMessage ? buttonMessage.buttons : media ? sanitizeButtons(media.buttons) : null,
				})
			}
			if (active) setDisplay(next)
		})()
		return () => {
			active = false
		}
	}, [rawMessages, keyVersion, activeId])

	// A link in the text gets a card built here, by the sender, and shipped
	// inside the encrypted message. A slow or unreachable site must never hold
	// up the send, so the whole thing is on a short leash.
	const buildLinkCard = useCallback(async (body: string): Promise<LinkPreviewCard | null> => {
		const url = firstUrl(body)
		if (!url) return null
		try {
			const result = await Promise.race([
				api.linkPreview(url),
				new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 4000)),
			])
			if (!result) return null
			const preview = result.preview
			if (!preview.title && !preview.description) return null
			let image: string | null = null
			if (preview.imageUrl) {
				const blob = await Promise.race([
					api.linkPreviewImage(preview.imageUrl),
					new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 4000)),
				])
				if (blob) image = await shrinkPreviewImage(blob)
			}
			return { url: preview.url, title: preview.title, description: preview.description, siteName: preview.siteName, image }
		} catch {
			return null
		}
	}, [])

	const appendMessage = useCallback((message: MessageEnvelope | null) => {
		if (!message || message.conversationId !== activeIdRef.current) return
		setRawMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
	}, [])

	// Seals a payload with the chat's current key and sends it now, silently,
	// or at a later time (the server delivers it then). Returns the message
	// when it went out right away.
	const deliverSealed = useCallback(async (conversationId: string, payload: string, options: SendOptions = {}, replyTo: string | null = null): Promise<MessageEnvelope | null> => {
		const keyring = ring()
		if (options.sendAt) {
			const sendAt = options.sendAt
			await keyring.sealAndSend(conversationId, payload, (ciphertext) => api.scheduleMessage(conversationId, { ciphertext, sendAt, replyTo, silent: options.silent === true }))
			setScheduledVersion((value) => value + 1)
			return null
		}
		const res = await keyring.sealAndSend(conversationId, payload, (ciphertext) => api.sendMessage(conversationId, { ciphertext, replyTo, silent: options.silent === true }))
		return res.message
	}, [])

	const handleSend = useCallback(
		async (body: string, replyToId: string | null, options: SendOptions = {}) => {
			const conversationId = activeIdRef.current
			if (!conversationId || !keyReady) return
			setError(null)
			try {
				const card = await buildLinkCard(body)
				const payload = card ? encodeLinkMessage({ text: body, preview: card }) : body
				appendMessage(await deliverSealed(conversationId, payload, options, replyToId))
				setComposerValue("")
				void api.saveConversationDraft(conversationId, null).catch(() => undefined)
				setDraft({ replyToId: null, replyToText: null, editingId: null, editingText: null })
				if (options.sendAt) pushToast({ title: t("scheduledTitle"), body: t("scheduledSaved") })
			} catch (err) {
				// No network: keep the message and send it when the line is back.
				if (isOfflineFailure(err) && !options.sendAt) {
					setOutbox((prev) => {
						const next = prev.concat([newOutboxItem(conversationId, body, replyToId, options.silent === true)])
						saveOutbox(next)
						return next
					})
					setComposerValue("")
					setDraft({ replyToId: null, replyToText: null, editingId: null, editingText: null })
					return
				}
				setError(errMessage(err, tt("sendMessageFailed")))
			}
		},
		[keyReady, appendMessage, deliverSealed, t],
	)

	// File names and types are sealed with the conversation key before they
	// reach the server; the readable copy travels inside the encrypted message.
	const sealFileMeta = useCallback(async (conversationId: string, name: string, mime: string) => {
		const keyring = ring()
		return { sealedName: await keyring.encrypt(conversationId, name), sealedMime: await keyring.encrypt(conversationId, mime) }
	}, [])

	const sendMediaBytes = useCallback(async (conversationId: string, name: string, mime: string, bytes: Uint8Array, caption?: string, extra?: Partial<MediaEnvelope>, options: SendOptions = {}): Promise<MessageEnvelope | null> => {
		const { sealedName, sealedMime } = await sealFileMeta(conversationId, name, mime)
		const created = await api.createFile({ conversationId, name: sealedName, mime: sealedMime, size: bytes.length })
		const packed = await packImage(created.asset.id, name, mime, bytes, extra)
		if (caption) packed.envelope.caption = caption
		await api.uploadFileBlob(created.asset.id, packed.cipher)
		return deliverSealed(conversationId, encodeMediaMessage(packed.envelope), options)
	}, [sealFileMeta, deliverSealed])

	// Attachment path: encrypt straight into a Blob and upload it with progress,
	// so neither memory nor the user's patience depends on the file size.
	const sendMediaFile = useCallback(async (
		conversationId: string,
		name: string,
		mime: string,
		file: Blob,
		caption: string | undefined,
		extra: Partial<MediaEnvelope> | undefined,
		onProgress: (stage: UploadStage, ratio: number) => void,
		options: SendOptions = {},
	): Promise<MessageEnvelope | null> => {
		const { sealedName, sealedMime } = await sealFileMeta(conversationId, name, mime)
		const created = await api.createFile({ conversationId, name: sealedName, mime: sealedMime, size: file.size })
		const packed = await packFileFromBlob(created.asset.id, name, mime, file, extra, (ratio) => onProgress("encrypt", ratio))
		if (caption) packed.envelope.caption = caption
		await api.uploadFileBlob(created.asset.id, packed.blob, (ratio) => onProgress("upload", ratio))
		return deliverSealed(conversationId, encodeMediaMessage(packed.envelope), options)
	}, [sealFileMeta, deliverSealed])

	const handleAttach = useCallback(
		async (file: File, caption: string, options: SendOptions & { spoiler?: boolean } = {}) => {
			const conversationId = activeIdRef.current
			if (!conversationId || !keyReady) return
			if (file.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
				setError(t("fileTooLarge") + " " + String(MAX_ATTACHMENT_MB) + " MB")
				return
			}
			setError(null)
			// Files from the clipboard or a share sheet can reach here unnamed, and an
			// empty name breaks the upload, so a fallback name is generated.
			const rawMime = file.type || "application/octet-stream"
			const safeName = file.name && file.name.trim() ? file.name : "file-" + String(Date.now()) + (rawMime.indexOf("image/") === 0 ? "." + rawMime.slice(6).split("+")[0] : "")
			const mime = guessMime(safeName, rawMime)
			const pendingId = "upload-" + String(Date.now()) + "-" + String(Math.round(Math.random() * 1e6))
			setPendingUploads((prev) => prev.concat([{ id: pendingId, conversationId, name: safeName, size: file.size, stage: "encrypt", progress: 0, poster: null }]))
			// Progress fires per chunk; only whole percents reach React.
			let lastShown = -1
			const report = (stage: UploadStage, ratio: number) => {
				const percent = Math.round(ratio * 100)
				const key = stage === "encrypt" ? percent : percent + 1000
				if (key === lastShown) return
				lastShown = key
				setPendingUploads((prev) => prev.map((item) => item.id === pendingId ? { ...item, stage, progress: ratio } : item))
			}
			try {
				// A video carries a still frame and its length in the envelope, so the
				// bubble shows a real preview before the file is downloaded.
				let extra: Partial<MediaEnvelope> | undefined = options.spoiler ? { spoiler: true } : undefined
				if (mime.indexOf("video/") === 0) {
					const shot = await captureVideoPoster(file)
					extra = {
						...(extra ?? {}),
						poster: shot.poster ?? undefined,
						duration: shot.duration ?? undefined,
						width: shot.width ?? undefined,
						height: shot.height ?? undefined,
					}
					if (shot.poster) setPendingUploads((prev) => prev.map((item) => item.id === pendingId ? { ...item, poster: shot.poster } : item))
				}
				appendMessage(await sendMediaFile(conversationId, safeName, mime, file, caption || undefined, extra, report, options))
			} catch (err) {
				setError(errMessage(err, t("sendFileFailed")))
			} finally {
				setPendingUploads((prev) => prev.filter((item) => item.id !== pendingId))
			}
		},
		[keyReady, t, sendMediaFile, appendMessage],
	)

	const handleSendVoice = useCallback(async (recording: VoiceRecording, options: SendOptions = {}) => {
		const conversationId = activeIdRef.current
		if (!conversationId || !keyReady) return
		setError(null)
		try {
			const name = "voice-" + String(Date.now()) + "." + voiceExtension(recording.mime)
			appendMessage(await sendMediaBytes(conversationId, name, recording.mime, recording.bytes, undefined, {
				kind: "voice",
				duration: recording.duration,
				waveform: recording.waveform,
			}, options))
		} catch (err) {
			setError(errMessage(err, tt("sendVoiceFailed")))
		}
	}, [keyReady, sendMediaBytes, appendMessage])

	const handleSendSticker = useCallback(async (sticker: Sticker) => {
		const conversationId = activeIdRef.current
		if (!conversationId || !keyReady) return
		setError(null)
		try {
			const { bytes, mime } = dataUrlToBytes(sticker.data)
			appendMessage(await sendMediaBytes(conversationId, "sticker", mime || "image/png", bytes))
		} catch (err) {
			setError(errMessage(err, tt("sendStickerFailed")))
		}
	}, [keyReady, sendMediaBytes, appendMessage])

	const handleSendGif = useCallback(async (url: string) => {
		const conversationId = activeIdRef.current
		if (!conversationId || !keyReady) return
		setError(null)
		try {
			const response = await fetch(url)
			const buffer = new Uint8Array(await response.arrayBuffer())
			const mime = response.headers.get("content-type") || "image/gif"
			appendMessage(await sendMediaBytes(conversationId, "animation." + (mime.indexOf("mp4") >= 0 ? "mp4" : mime.indexOf("webm") >= 0 ? "webm" : "gif"), mime, buffer))
		} catch (err) {
			setError(errMessage(err, tt("sendGifFailed")))
		}
	}, [keyReady, sendMediaBytes, appendMessage])

	const handleSendLocation = useCallback(async (location: LocationPayload, options: SendOptions = {}) => {
		const conversationId = activeIdRef.current
		if (!conversationId || !keyReady) return
		setError(null)
		try {
			appendMessage(await deliverSealed(conversationId, encodeLocation(location), options))
		} catch (err) {
			setError(errMessage(err, tt("sendMessageFailed")))
		}
	}, [keyReady, deliverSealed, appendMessage])

	const handleSendContact = useCallback(async (contact: ContactPayload, options: SendOptions = {}) => {
		const conversationId = activeIdRef.current
		if (!conversationId || !keyReady) return
		setError(null)
		try {
			appendMessage(await deliverSealed(conversationId, encodeContact(contact), options))
		} catch (err) {
			setError(errMessage(err, tt("sendMessageFailed")))
		}
	}, [keyReady, deliverSealed, appendMessage])

	const handleForward = useCallback(async (targetConversationId: string) => {
		const message = forwardFor
		setForwardFor(null)
		if (!message) return
		setError(null)
		try {
			if (message.media) {
				const cipher = await api.downloadFileBlob(message.media.fileId)
				const bytes = await unpackImage(message.media, cipher)
				const extra: Partial<MediaEnvelope> | undefined = message.media.kind === "voice"
					? { kind: "voice", duration: message.media.duration, waveform: message.media.waveform }
					: message.media.spoiler ? { spoiler: true } : undefined
				appendMessage(await sendMediaBytes(targetConversationId, message.media.name, message.media.mime, bytes, message.media.caption, extra))
			} else {
				const body = message.poll
					? t("pollShort")
					: message.location
						? encodeLocation(message.location)
						: message.contact
							? encodeContact(message.contact)
							: (message.text ?? "")
				if (!body) return
				appendMessage(await deliverSealed(targetConversationId, body))
			}
		} catch (err) {
			setError(errMessage(err, tt("forwardFailed")))
		}
	}, [forwardFor, sendMediaBytes, deliverSealed, appendMessage, t])

	const handleCreatePoll = useCallback(async (input: PollDraftInput) => {
		const conversationId = activeIdRef.current
		if (!conversationId || !keyReady) throw new Error(t("encryptionSettingUp"))
		const result = await ring().sealAndSend(conversationId, encodePollMessage(input), (ciphertext) => api.createPoll(conversationId, { ciphertext, optionCount: input.options.length, multipleChoice: input.multipleChoice, quiz: input.quiz }))
		setRawMessages((previous) => previous.some((message) => message.id === result.message.id) ? previous : previous.concat([result.message]))
		setPolls((previous) => [result.poll, ...previous.filter((poll) => poll.messageId !== result.poll.messageId)])
	}, [keyReady, t])

	const handleSubmitEdit = useCallback(
		async (messageId: string, body: string) => {
			const conversationId = activeIdRef.current
			if (!conversationId || !keyReady) return
			setError(null)
			try {
				const res = await ring().sealAndSend(conversationId, body, (ciphertext) => api.editMessage(conversationId, messageId, { ciphertext }))
				setRawMessages((prev) => prev.map((m) => (m.id === messageId ? res.message : m)))
				setComposerValue("")
				setDraft({ replyToId: null, replyToText: null, editingId: null, editingText: null })
			} catch (err) {
				setError(errMessage(err, tt("editMessageFailed")))
			}
		},
		[keyReady],
	)

	const handleDelete = useCallback(async (message: DisplayMessage) => {
		const conversationId = activeIdRef.current
		if (!conversationId) return
		setError(null)
		try {
			await api.deleteMessage(conversationId, message.id)
			const at = new Date().toISOString()
			setRawMessages((prev) =>
				prev.map((m) => (m.id === message.id ? { ...m, ciphertext: "", deletedAt: at } : m)),
			)
			setPinned((prev) => prev.filter((item) => item.messageId !== message.id))
		} catch (err) {
			setError(errMessage(err, tt("deleteMessageFailed")))
		}
	}, [])

	const handleToggleReaction = useCallback(
		async (messageId: string, emoji: string, active: boolean) => {
			const conversationId = activeIdRef.current
			if (!conversationId || !currentUserId) return
			setReactions((prev) => {
				const rest = prev.filter(
					(r) => r.messageId !== messageId || r.userId !== currentUserId || r.emoji !== emoji,
				)
				if (!active) return rest
				return rest.concat([
					{ messageId, userId: currentUserId, emoji, at: new Date().toISOString() },
				])
			})
			try {
				await api.setReaction(conversationId, messageId, { emoji, active })
			} catch (err) {
				setError(errMessage(err, tt("reactionFailed")))
			}
		},
		[currentUserId],
	)

	const handleTogglePin = useCallback(async (messageId: string, active: boolean) => {
		const conversationId = activeIdRef.current
		if (!conversationId) return
		setError(null)
		try {
			const result = await api.setPinnedMessage(conversationId, messageId, active)
			setPinned((prev) => {
				const rest = prev.filter((item) => item.messageId !== messageId)
				return active && result.pinnedAt ? rest.concat([{ conversationId, messageId, pinnedBy: currentUserId, pinnedAt: result.pinnedAt }]) : rest
			})
		} catch (err) {
			setError(errMessage(err, tt("pinFailed")))
		}
	}, [currentUserId])

	const handleVotePoll = useCallback(async (messageId: string, optionIndexes: number[]) => {
		const conversationId = activeIdRef.current
		if (!conversationId) throw new Error(tt("noActiveConversation"))
		try {
			const result = await api.votePoll(conversationId, messageId, optionIndexes)
			setPolls((previous) => previous.map((poll) => poll.messageId === messageId ? result.poll : poll))
		} catch (err) {
			const message = errMessage(err, tt("voteFailed"))
			setError(message)
			throw new Error(message)
		}
	}, [])
	const handleClosePoll = useCallback(async (messageId: string) => {
		const conversationId = activeIdRef.current
		if (!conversationId) throw new Error(tt("noActiveConversation"))
		try {
			const result = await api.closePoll(conversationId, messageId)
			setPolls((previous) => previous.map((poll) => poll.messageId === messageId ? result.poll : poll))
		} catch (err) {
			const message = errMessage(err, tt("closePollFailed"))
			setError(message)
			throw new Error(message)
		}
	}, [])
	const handleMuteFor = useCallback(async (durationMs: number | null) => {
		const conversation = conversations.find((item) => item.id === activeIdRef.current)
		if (!conversation) return
		try {
			const until = durationMs === null ? null : new Date(Date.now() + durationMs).toISOString()
			const result = await api.setConversationMuted(conversation.id, until)
			setConversations((prev) => prev.map((item) => item.id === conversation.id ? { ...item, mutedUntil: result.mutedUntil } : item))
		} catch (err) {
			setError(errMessage(err, tt("muteFailed")))
		}
	}, [conversations])
	const handleArchive = useCallback(async () => {
		const conversation = conversations.find((item) => item.id === activeIdRef.current)
		if (!conversation) return
		setError(null)
		try {
			const result = await api.archiveConversation(conversation.id, !conversation.archivedAt)
			setConversations((prev) => prev.map((item) => item.id === conversation.id ? { ...item, archivedAt: result.archivedAt } : item))
		} catch (err) {
			setError(errMessage(err, tt("archiveFailed")))
		}
	}, [conversations])

	const handleRoleChange = useCallback(async (memberId: string, role: MemberRole) => {
		const conversationId = activeIdRef.current
		if (!conversationId) return
		await api.setMemberRole(conversationId, memberId, role)
		setMembers((prev) => prev.map((member) => member.userId === memberId ? { ...member, role } : member))
	}, [])

	const handleSaveConversationProfile = useCallback(async (input: { title?: string; avatar?: string | null }) => {
		const conversationId = activeIdRef.current
		if (!conversationId) return
		const result = await api.setConversationProfile(conversationId, input)
		setConversations((prev) => prev.map((item) => item.id === conversationId ? result.conversation : item))
	}, [])

	const refreshMembers = useCallback(async (conversationId: string) => {
		try { const res = await api.getConversationMembers(conversationId); setMembers(res.members) } catch { /* ignore */ }
	}, [])

	const handleMembersChanged = useCallback(() => {
		const id = activeIdRef.current
		if (id) void refreshMembers(id)
	}, [refreshMembers])

	const handleLeaveConversation = useCallback(async () => {
		const id = activeIdRef.current
		if (!id) return
		try {
			await api.leaveConversation(id)
			setShowMembers(false)
			setConversations((prev) => prev.filter((c) => c.id !== id))
			if (activeIdRef.current === id) setActiveId(null)
		} catch (err) {
			setError(errMessage(err, tt("leaveConversationFailed")))
		}
	}, [])

	const handleDeleteConversation = useCallback(async () => {
		const id = activeIdRef.current
		if (!id) return
		try {
			await api.deleteConversation(id)
			setShowMembers(false)
			setConversations((prev) => prev.filter((c) => c.id !== id))
			if (activeIdRef.current === id) setActiveId(null)
		} catch (err) {
			setError(errMessage(err, tt("deleteConversationFailed")))
		}
	}, [])

	const handleOpenComments = useCallback(async (message: DisplayMessage) => {
		const conversationId = activeIdRef.current
		if (!conversationId) return
		setCommentsFor(message)
		setComments([])
		setCommentsLoading(true)
		try {
			const keyring = ring()
			const res = await api.listComments(conversationId, message.id)
			const items: CommentItem[] = []
			for (const envelope of res.comments) {
				let text = ""
				try { text = await keyring.decrypt(conversationId, envelope.ciphertext) } catch { text = "" }
				const author = members.find((m) => m.userId === envelope.senderId)
				items.push({ id: envelope.id, author: author ? (author.displayName || author.username) : envelope.senderId, text, createdAt: envelope.createdAt, isSelf: envelope.senderId === currentUserId })
			}
			setComments(items)
		} catch (err) {
			setError(errMessage(err, tt("loadCommentsFailed")))
		} finally {
			setCommentsLoading(false)
		}
	}, [members, currentUserId])

	const handlePostComment = useCallback(async (text: string) => {
		const conversationId = activeIdRef.current
		const message = commentsFor
		if (!conversationId || !message) return
		const res = await ring().sealAndSend(conversationId, text, (ciphertext) => api.postComment(conversationId, message.id, { ciphertext }))
		const author = members.find((m) => m.userId === res.message.senderId)
		setComments((prev) => [...prev, { id: res.message.id, author: author ? (author.displayName || author.username) : (user?.displayName || user?.username || res.message.senderId), text, createdAt: res.message.createdAt, isSelf: true }])
	}, [commentsFor, members, user])

	const togglePinChat = useCallback((id: string) => {
		setPinnedChats((prev) => {
			const next = prev.includes(id) ? prev.filter((value) => value !== id) : [id, ...prev]
			try { window.localStorage.setItem(accountKey(PINNED_CHATS_KEY), JSON.stringify(next)) } catch { /* ignore */ }
			return next
		})
	}, [])

	const handleTyping = useCallback(() => {
		const conversationId = activeIdRef.current
		if (!conversationId) return
		const now = Date.now()
		if (now - lastTypingSentRef.current < 2000) return
		lastTypingSentRef.current = now
		void api.sendTyping(conversationId).catch(() => undefined)
	}, [])

	const handleLoadOlder = useCallback(async () => {
		const conversationId = activeIdRef.current
		const oldest = rawMessages.length > 0 ? rawMessages[0] : null
		if (!conversationId || !oldest) return
		setLoadingOlder(true)
		try {
			const res = await api.listMessages(conversationId, { limit: PAGE_SIZE, before: oldest.id })
			setRawMessages((prev) => {
				const known = new Set(prev.map((m) => m.id))
				return res.messages.filter((m) => !known.has(m.id)).concat(prev)
			})
			setHasMore(res.hasMore)
		} catch (err) {
			setError(errMessage(err, tt("loadEarlierFailed")))
		} finally {
			setLoadingOlder(false)
		}
	}, [rawMessages])

	const handleReply = useCallback((message: DisplayMessage) => {
		setDraft({
			replyToId: message.id,
			replyToText: message.locked ? null : message.text,
			editingId: null,
			editingText: null,
		})
	}, [])

	const handleEdit = useCallback((message: DisplayMessage) => {
		// Only plain text is editable: the body of a photo, file or voice message
		// is its media envelope, and replacing it would orphan the attachment.
		if (message.locked || message.media || message.poll || message.text === null) return
		setComposerValue(message.text)
		setDraft({
			replyToId: null,
			replyToText: null,
			editingId: message.id,
			editingText: message.text,
		})
	}, [])

	const handleCancelDraft = useCallback(() => {
		setComposerValue("")
		setDraft({ replyToId: null, replyToText: null, editingId: null, editingText: null })
	}, [])

	const handleCreated = useCallback((conversation: Conversation) => {
		setConversations((prev) => [conversation, ...prev.filter((c) => c.id !== conversation.id)])
		setActiveId(conversation.id)
		setShowNew(false)
	}, [])

	useEffect(() => {
		const timer = window.setInterval(() => setTypingTick((n) => n + 1), 1000)
		return () => window.clearInterval(timer)
	}, [])

	const typingLabel = useMemo(() => {
		void typingTick
		const now = Date.now()
		const busy = Object.keys(typingUntil).filter(
			(id) => id !== currentUserId && (typingUntil[id] ?? 0) > now,
		)
		if (busy.length === 0) return null
		if (busy.length === 1) return t("someoneTyping")
		return String(busy.length) + " " + t("peopleTyping")
	}, [typingTick, typingUntil, currentUserId, t])

	const activeConversation = useMemo(
		() => conversations.find((c) => c.id === activeId) ?? null,
		[conversations, activeId],
	)
	const pinnedChatSet = useMemo(() => new Set(pinnedChats), [pinnedChats])
	const activeFolder = useMemo(() => folders.find((folder) => folder.id === activeFolderId) ?? null, [folders, activeFolderId])
	const orderedConversations = useMemo(() => {
		let list = conversations.filter((conversation) => showArchived ? Boolean(conversation.archivedAt) : !conversation.archivedAt)
		if (activeFolder) list = list.filter((conversation) => activeFolder.conversationIds.includes(conversation.id))
		const rank = (conversation: Conversation) => conversation.isSelf ? 0 : (pinnedChats.includes(conversation.id) ? 1 : 2)
		return [...list].sort((a, b) => rank(a) - rank(b))
	}, [conversations, showArchived, pinnedChats, activeFolder])
	// Unread counters per tab, so a filtered-away chat still announces itself.
	const folderUnread = useMemo(() => {
		const counts: Record<string, number> = {}
		for (const folder of folders) {
			let total = 0
			for (const id of folder.conversationIds) total += unread[id] ?? 0
			counts[folder.id] = total
		}
		return counts
	}, [folders, unread])
	const allUnread = useMemo(() => {
		let total = 0
		for (const conversation of conversations) {
			if (conversation.archivedAt) continue
			total += unread[conversation.id] ?? 0
		}
		return total
	}, [conversations, unread])
	const folderPickerChats = useMemo(
		() => conversations.filter((conversation) => !conversation.archivedAt),
		[conversations],
	)
	const activeMember = useMemo(() => members.find((member) => member.userId === currentUserId) ?? null, [members, currentUserId])
	const onlineOtherMemberCount = useMemo(
		() => members.filter((member) => member.userId !== currentUserId && onlineUserIds.includes(member.userId)).length,
		[members, onlineUserIds, currentUserId],
	)
	// In a one-to-one chat an offline peer shows when they were last online,
	// if their settings allow it.
	const directPeerSeen = activeConversation?.kind === "direct"
		? (() => {
			const peer = members.find((member) => member.userId !== currentUserId)
			return peer ? lastSeen[peer.userId] ?? null : null
		})()
		: null
	const presenceLabel = members.length === 0
		? t("checkingPresence")
		: onlineOtherMemberCount === 0
			? (activeConversation?.kind === "direct"
				? (directPeerSeen ? formatLastSeen(lang, directPeerSeen, clockNow) : t("offlineLabel"))
				: t("noOthersOnline"))
			// A one-to-one chat has one other person: "online", not "1 online".
			: activeConversation?.kind === "direct" ? t("online") : String(onlineOtherMemberCount) + " " + t("online")
	const canModerate = activeConversation?.kind === "direct" || activeMember?.role === "owner" || activeMember?.role === "admin"
	const canSend = activeConversation?.kind === "channel" ? activeMember?.role === "owner" || activeMember?.role === "admin" : activeMember?.role !== "restricted"
	const canComment = Boolean(activeMember)
	const pinnedIds = useMemo(() => new Set(pinned.map((item) => item.messageId)), [pinned])
	const activeMuted = Boolean(activeConversation?.mutedUntil && new Date(activeConversation.mutedUntil).getTime()>Date.now())
	const canCloseAnyPoll = activeConversation?.kind !== "direct" && (activeMember?.role === "owner" || activeMember?.role === "admin")
	const incomingCall = call.incoming
	const incomingCallConv = incomingCall ? conversations.find((item) => item.id === incomingCall.conversationId) : undefined
	const incomingCallLabel = incomingCallConv ? convTitle(incomingCallConv) : t("call")
	const pollsByMessage = useMemo(() => new Map(polls.map((poll) => [poll.messageId, poll])), [polls])
	const filteredDisplay = useMemo(() => {
		const base = activeConversation?.kind === "channel" ? display.filter((message) => !message.replyTo) : display
		const query = searchQuery.trim().toLocaleLowerCase()
		if (!query) return base
		return base.filter((message) => !message.locked && (message.text ?? "").toLocaleLowerCase().includes(query))
	}, [display, searchQuery, activeConversation])

	// Photos and videos of the open chat, oldest first - the order the viewer and
	// the gallery walk through.
	const viewerItems = useMemo<ViewerItem[]>(() => {
		const out: ViewerItem[] = []
		for (const message of display) {
			const media = message.media
			if (!media || message.deleted || message.locked) continue
			if (media.kind !== "image" && !isVideoMedia(media)) continue
			const member = members.find((m) => m.userId === message.senderId)
			const author = message.senderId === currentUserId
				? (user?.displayName || user?.username || t("you"))
				: member ? (member.displayName || member.username) : t("unknownUser")
			out.push({ messageId: message.id, media, author, createdAt: message.createdAt })
		}
		return out
	}, [display, members, currentUserId, user, t])

	const pinnedMessages = useMemo(
		() => display.filter((message) => pinnedIds.has(message.id) && !message.deleted),
		[display, pinnedIds],
	)

	const messagePreview = useCallback((message: DisplayMessage): string => {
		if (message.locked) return t("messageEncrypted")
		if (message.poll) return t("pollShort")
		if (message.media) return message.media.kind === "image" ? t("photo") : message.media.kind === "voice" ? t("voiceMessage") : (message.media.name || t("file"))
		const body = stripFormatting(message.text ?? "")
		return body.length > 90 ? body.slice(0, 90) + "..." : body
	}, [t])

	const messageAuthor = useCallback((message: DisplayMessage): string => {
		if (message.senderId === currentUserId) return user?.displayName || user?.username || t("you")
		const member = members.find((m) => m.userId === message.senderId)
		return member ? (member.displayName || member.username) : t("unknownUser")
	}, [members, currentUserId, user, t])

	const openViewerForMessage = useCallback((messageId: string) => {
		const position = viewerItems.findIndex((item) => item.messageId === messageId)
		if (position >= 0) setViewerIndex(position)
	}, [viewerItems])

	// The queue is drained in order: one failure stops the pass and the rest
	// waits for the next attempt, so messages never arrive out of order.
	const flushOutbox = useCallback(async () => {
		const items = loadOutbox()
		if (items.length === 0) return
		const remaining = items.slice()
		while (remaining.length > 0) {
			const item = remaining[0]
			const keyring = activeKeyring()
			if (!keyring) break
			try {
				const card = await buildLinkCard(item.body)
				const payload = card ? encodeLinkMessage({ text: item.body, preview: card }) : item.body
				const res = await keyring.sealAndSend(item.conversationId, payload, (ciphertext) => api.sendMessage(item.conversationId, { ciphertext, replyTo: item.replyTo, silent: item.silent === true }))
				remaining.shift()
				saveOutbox(remaining)
				setOutbox(remaining.slice())
				if (res.message.conversationId === activeIdRef.current) {
					setRawMessages((prev) => prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message])
				}
			} catch (err) {
				if (isOfflineFailure(err) || err instanceof KeyUnavailableError) break
				// A message the server refuses would block the queue forever.
				remaining.shift()
				saveOutbox(remaining)
				setOutbox(remaining.slice())
				setError(errMessage(err, tt("sendMessageFailed")))
			}
		}
	}, [buildLinkCard])

	useEffect(() => {
		if (outbox.length === 0) return
		void flushOutbox()
		const onOnline = () => { void flushOutbox() }
		window.addEventListener("online", onOnline)
		const timer = window.setInterval(() => { void flushOutbox() }, 15000)
		return () => {
			window.removeEventListener("online", onOnline)
			window.clearInterval(timer)
		}
	}, [outbox.length, flushOutbox])

	// Export walks the whole history of the chat, decrypting page by page.
	const handleExportChat = useCallback(async () => {
		const conversation = conversations.find((item) => item.id === activeIdRef.current)
		if (!conversation || exporting) return
		setExporting(true)
		setError(null)
		try {
			const keyring = ring()
			const collected: MessageEnvelope[] = []
			let before: string | null = null
			for (let page = 0; page < 200; page++) {
				const res = await api.listMessages(conversation.id, { limit: 200, before })
				if (res.messages.length === 0) break
				collected.unshift(...res.messages)
				before = res.messages[0].id
				if (!res.hasMore) break
			}
			const lines: ExportMessage[] = []
			for (const message of collected) {
				const member = members.find((m) => m.userId === message.senderId)
				const author = message.senderId === currentUserId
					? (user?.displayName || user?.username || t("you"))
					: member ? (member.displayName || member.username) : t("unknownUser")
				if (message.deletedAt) {
					lines.push({ author, createdAt: message.createdAt, text: "", kind: "deleted", detail: t("messageDeleted") })
					continue
				}
				let text: string | null = null
				try {
					text = await keyring.decrypt(conversation.id, message.ciphertext)
				} catch {
					text = null
				}
				if (text === null) {
					lines.push({ author, createdAt: message.createdAt, text: "", kind: "locked", detail: t("messageEncrypted") })
					continue
				}
				const media = parseMediaMessage(text)
				if (media) {
					const label = media.kind === "image" ? t("photo") : media.kind === "voice" ? t("voiceMessage") : (media.name || t("file"))
					lines.push({ author, createdAt: message.createdAt, text: "", kind: "media", detail: label + (media.caption ? " - " + media.caption : "") })
					continue
				}
				if (parsePollMessage(text)) {
					lines.push({ author, createdAt: message.createdAt, text: "", kind: "poll", detail: t("pollShort") })
					continue
				}
				const location = parseLocation(text)
				if (location) {
					lines.push({ author, createdAt: message.createdAt, text: "", kind: "media", detail: t("locationShort") + " " + location.lat.toFixed(5) + ", " + location.lon.toFixed(5) })
					continue
				}
				const contact = parseContact(text)
				if (contact) {
					lines.push({ author, createdAt: message.createdAt, text: "", kind: "media", detail: t("contactShort") + " " + contact.displayName })
					continue
				}
				const buttonMessage = parseButtonMessage(text)
				const link = parseLinkMessage(text)
				lines.push({ author, createdAt: message.createdAt, text: stripFormatting(buttonMessage ? buttonMessage.text : link ? link.text : text), kind: "text" })
			}
			const title = convTitle(conversation)
			downloadTextFile(safeFileName(title), buildExportHtml(title, lines, lang))
		} catch (err) {
			setError(errMessage(err, t("exportFailed")))
		} finally {
			setExporting(false)
		}
	}, [conversations, exporting, members, currentUserId, user, t, lang, convTitle])

	// Files dropped anywhere on the conversation are staged in the composer.
	const onDropFiles = useCallback((event: ReactDragEvent<HTMLElement>) => {
		event.preventDefault()
		setDragOver(false)
		const list = event.dataTransfer && event.dataTransfer.files ? Array.from(event.dataTransfer.files) : []
		if (list.length > 0) setDroppedFiles(list)
	}, [])

	const commentsParent = useMemo(() => {
		if (!commentsFor) return null
		const text = commentsFor.locked ? t("messageEncrypted") : (commentsFor.text ?? "")
		let author: string
		if (commentsFor.senderId === currentUserId) author = user?.displayName || user?.username || t("you")
		else { const found = members.find((m) => m.userId === commentsFor.senderId); author = found ? (found.displayName || found.username) : t("unknownUser") }
		return { author, text }
	}, [commentsFor, members, currentUserId, user, t])

	const directPeer = useMemo(() => (activeConversation && activeConversation.kind === "direct" && !activeConversation.isSelf ? (activeConversation.peer ?? null) : null), [activeConversation])

	// Sidebar resizing. The pointer is captured by the handle itself, so the
	// drag keeps working when the cursor runs ahead of the moving edge.
	const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 && event.pointerType === "mouse") return
		event.preventDefault()
		const handle = event.currentTarget
		const pointerId = event.pointerId
		const move = (moveEvent: PointerEvent) => setSidebarWidth(clampSidebarWidth(moveEvent.clientX))
		const stop = () => {
			handle.removeEventListener("pointermove", move)
			handle.removeEventListener("pointerup", stop)
			handle.removeEventListener("pointercancel", stop)
			document.body.classList.remove("sidebar-resizing")
			try {
				handle.releasePointerCapture(pointerId)
			} catch {
				// The capture is already gone when the pointer left the window.
			}
		}
		try {
			handle.setPointerCapture(pointerId)
		} catch {
			// Without capture the drag still works while the pointer stays inside.
		}
		document.body.classList.add("sidebar-resizing")
		handle.addEventListener("pointermove", move)
		handle.addEventListener("pointerup", stop)
		handle.addEventListener("pointercancel", stop)
	}, [])

	const onSidebarResizeKey = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key === "ArrowLeft") {
			event.preventDefault()
			setSidebarWidth((width) => clampSidebarWidth(width - 16))
		} else if (event.key === "ArrowRight") {
			event.preventDefault()
			setSidebarWidth((width) => clampSidebarWidth(width + 16))
		} else if (event.key === "Home") {
			event.preventDefault()
			setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)
		}
	}, [])

	const openConversationById = useCallback((conversationId: string) => {
		setGlobalQuery("")
		setGlobalOpen(false)
		setActiveId(conversationId)
	}, [])

	// A search hit or a notification: open the chat at that message, loading a
	// window of history around it when it is not on screen.
	const openMessage = useCallback((conversationId: string, messageId: string) => {
		setGlobalQuery("")
		setGlobalOpen(false)
		if (activeIdRef.current === conversationId) {
			if (rawMessages.some((message) => message.id === messageId)) {
				setJumpToId(messageId)
				return
			}
			setLoadingMessages(true)
			void api
				.messagesAround(conversationId, messageId, PAGE_SIZE)
				.then((res) => {
					if (activeIdRef.current !== conversationId) return
					setRawMessages(res.messages)
					setHasMore(res.hasMore)
					setHasNewer(res.hasNewer)
					window.setTimeout(() => setJumpToId(messageId), 60)
				})
				.catch((err) => setError(errMessage(err, tt("loadMessagesFailed"))))
				.finally(() => setLoadingMessages(false))
			return
		}
		pendingJumpRef.current = { conversationId, messageId }
		setActiveId(conversationId)
	}, [rawMessages])

	const handleLoadNewer = useCallback(async () => {
		const conversationId = activeIdRef.current
		const newest = rawMessages.length > 0 ? rawMessages[rawMessages.length - 1] : null
		if (!conversationId || !newest) return
		setLoadingNewer(true)
		try {
			const res = await api.messagesAfter(conversationId, newest.id, PAGE_SIZE)
			setRawMessages((prev) => {
				const known = new Set(prev.map((m) => m.id))
				return prev.concat(res.messages.filter((m) => !known.has(m.id)))
			})
			setHasNewer(res.hasNewer)
		} catch (err) {
			setError(errMessage(err, tt("loadEarlierFailed")))
		} finally {
			setLoadingNewer(false)
		}
	}, [rawMessages])

	// Opening a chat with someone by username: the existing chat, a bot (which
	// starts right away) or a friend request.
	// A button under a bot's message: links open outside the app, the rest go
	// back to the bot sealed with the chat key. Resolves when the bot answers
	// (or after a while, so the button never spins forever).
	const handleBotButton = useCallback(async (message: DisplayMessage, button: BotButton) => {
		if (button.url) {
			window.open(button.url, "_blank", "noopener,noreferrer")
			return
		}
		if (!button.data) return
		try {
			const sealed = await ring().encrypt(message.conversationId, button.data)
			const res = await api.botCallback(message.conversationId, message.id, sealed)
			await new Promise<void>((resolve) => {
				const timer = window.setTimeout(() => {
					callbackWaiters.current.delete(res.callbackId)
					resolve()
				}, 10000)
				callbackWaiters.current.set(res.callbackId, () => {
					window.clearTimeout(timer)
					resolve()
				})
			})
		} catch (err) {
			setError(errMessage(err, t("botButtonFailed")))
		}
	}, [t])

	const startChatWith = useCallback(async (username: string) => {
		const existing = conversationsRef.current.find((conversation) => conversation.kind === "direct" && conversation.peer && conversation.peer.username.toLowerCase() === username.toLowerCase())
		if (existing) {
			openConversationById(existing.id)
			return
		}
		setError(null)
		try {
			const res = await api.sendFriendRequest(username)
			if (res.status === "accepted" && res.conversation) {
				const conversation = res.conversation
				setConversations((prev) => (prev.some((c) => c.id === conversation.id) ? prev : [conversation, ...prev]))
				openConversationById(conversation.id)
			} else {
				pushToast({ title: t("friendRequests"), body: t("friendRequestSent") })
			}
		} catch (err) {
			setError(errMessage(err, tt("friendActionFailed")))
		}
	}, [openConversationById, t])

	// Notifications (web push, native) open a chat, switching accounts first
	// when the notification belongs to another account on this device.
	useEffect(() => {
		const handle = (conversationId: string, accountId: string) => {
			if (accountId && user && accountId !== user.id) {
				if (!accounts.some((account) => account.id === accountId)) return
				setActiveAccountId(accountId)
				window.location.assign("/?open=" + encodeURIComponent(conversationId))
				return
			}
			if (conversationId) setActiveId(conversationId)
		}
		const params = new URLSearchParams(window.location.search)
		const open = params.get("open")
		const account = params.get("account")
		if (open || account) {
			window.history.replaceState(null, "", window.location.pathname)
			handle(open ?? "", account ?? "")
		}
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; conversationId?: string; accountId?: string } | null
			if (data && data.type === "frontierx:open") handle(String(data.conversationId ?? ""), String(data.accountId ?? ""))
		}
		const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined
		sw?.addEventListener("message", onMessage)
		return () => sw?.removeEventListener("message", onMessage)
	}, [])

	useEffect(() => {
		void syncWebPush().catch(() => undefined)
	}, [])

	// Locked keys: offer the ways back as soon as the chat opens.
	useEffect(() => {
		if (keys.status === "locked") setUnlockOpen(true)
	}, [keys.status])

	// A device that asked to be linked while this one was away.
	useEffect(() => {
		if (keys.status !== "ready") return
		void api.pendingLinks().then((res) => { if (res.requests.length > 0) setLinkRequest(res.requests[0]) }).catch(() => undefined)
	}, [keys.status])

	// Keys somebody still waits for are handed over every few minutes.
	useEffect(() => {
		if (!keyring) return
		const timer = window.setInterval(() => void keyring.syncPending().catch(() => undefined), 180000)
		return () => window.clearInterval(timer)
	}, [keyring])

	// A bot's commands, offered in the composer.
	useEffect(() => {
		const peer = activeConversation?.peer
		if (!peer || !peer.isBot) {
			setBotCommands([])
			return
		}
		let alive = true
		void api.botProfile(peer.id).then((res) => { if (alive) setBotCommands(res.commands) }).catch(() => { if (alive) setBotCommands([]) })
		return () => { alive = false }
	}, [activeConversation?.id])

	// An action picked in a chat's menu runs once that chat is the open one.
	useEffect(() => {
		if (!pendingChatAction || activeConversation?.id !== pendingChatAction.id) return
		const key = pendingChatAction.key
		setPendingChatAction(null)
		const timer = window.setTimeout(() => headerMenuItemsRef.current.find((item) => item.key === key)?.onSelect(), 60)
		return () => window.clearTimeout(timer)
	}, [pendingChatAction, activeConversation?.id])

	// Ctrl/Cmd+K searches everywhere.
	const globalInputRef = useRef<HTMLInputElement | null>(null)
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
				event.preventDefault()
				setGlobalOpen(true)
				window.setTimeout(() => globalInputRef.current?.focus(), 0)
			}
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [])

	const nameOf = useCallback((userId: string): string => {
		if (userId === currentUserId) return t("you")
		const member = members.find((m) => m.userId === userId)
		if (member) return member.displayName || member.username
		const peer = conversations.find((conversation) => conversation.peer && conversation.peer.id === userId)?.peer
		return peer ? peer.displayName || peer.username : t("unknownUser")
	}, [members, conversations, currentUserId, t])

	const otherAccounts = accounts.filter((account) => account.id !== currentUserId)
	const otherUnread = otherAccounts.reduce((total, account) => total + (backgroundUnread[account.id] ?? 0), 0)
	const accountMenuItems: MenuItemSpec[] = [
		...otherAccounts.map((account) => ({
			key: account.id,
			label: account.displayName || account.username,
			icon: <Avatar src={account.avatar} label={account.displayName || account.username} seed={account.id} size={28} />,
			hint: backgroundUnread[account.id] ? String(backgroundUnread[account.id]) : account.token ? "@" + account.username : t("accountSignedOut"),
			onSelect: () => switchAccount(account.id),
		})),
		...(accounts.length < MAX_ACCOUNTS ? [{ key: "add", label: t("addAccount"), icon: <IAdd size={20} />, onSelect: () => window.location.assign("/login?add=1") }] : []),
		{ key: "settings", label: t("settings"), icon: <ISettingsGear />, onSelect: () => setSettingsPage("home") },
		{ key: "signout", label: t("signOut"), icon: <ILogout size={20} />, danger: true, onSelect: () => setSignOutOpen(true) },
	]

	const headerMenuItems: MenuItemSpec[] = activeConversation ? [
		...(!activeConversation.isSelf && activeConversation.kind !== "direct" ? [{ key: "members", label: t("members"), icon: <IPeople size={20} />, onSelect: () => setShowMembers(true) }] : []),
		...(directPeer ? [{ key: "safety", label: t("encryptionVerify"), icon: <IShield size={20} />, onSelect: () => setSafetyOpen(true) }] : []),
		...(!activeConversation.isSelf ? [{ key: "mute", label: activeMuted ? t("unmute") : t("notifications"), icon: activeMuted ? <IBell size={20} /> : <IBellOff size={20} />, onSelect: () => (activeMuted ? void handleMuteFor(null) : setChoice("mute")) }] : []),
		{ key: "scheduled", label: t("scheduledTitle") + (activeConversation.scheduledCount ? " · " + String(activeConversation.scheduledCount) : ""), icon: <ISchedule size={20} />, onSelect: () => setShowScheduled(true) },
		{ key: "gallery", label: t("galleryOpen"), icon: <IGallery size={20} />, onSelect: () => setShowGallery(true) },
		{ key: "export", label: exporting ? t("exporting") : t("exportChat"), icon: <IDownload size={20} />, disabled: exporting, onSelect: () => void handleExportChat() },
		...(canModerate ? [{ key: "ttl", label: t("ttlMenu"), icon: <IClock size={20} />, hint: activeConversation.ttlSeconds ? ttlLabel(activeConversation.ttlSeconds, t) : undefined, onSelect: () => setChoice("ttl") }] : []),
		{ key: "folders", label: t("addToFolder"), icon: <IGallery size={20} />, onSelect: () => (folders.length === 0 ? setShowFolders(true) : setChoice("folders")) },
		...(!activeConversation.isSelf ? [{ key: "pin", label: pinnedChatSet.has(activeConversation.id) ? t("unpinChat") : t("pinChat"), icon: <IPin size={20} />, onSelect: () => togglePinChat(activeConversation.id) }] : []),
		...(!activeConversation.isSelf ? [{ key: "archive", label: activeConversation.archivedAt ? t("unarchive") : t("archive"), icon: <IStorage size={20} />, onSelect: () => void handleArchive() }] : []),
		...(directPeer ? [{ key: "remove", label: t("removeFriend"), icon: <ITrash size={20} />, danger: true, onSelect: () => setConfirmRemoveFriend(true) }] : []),
	] : []

	// What a chat's menu offers when it is not the open one; anything that needs
	// the chat opens it first and then runs the same action as the ⋮ menu.
	const chatMenuItems = (conversation: Conversation): MenuItemSpec[] => {
		if (conversation.id === activeConversation?.id) return headerMenuItems
		const later = (key: string) => () => {
			setPendingChatAction({ id: conversation.id, key })
			setActiveId(conversation.id)
		}
		const peer = conversation.kind === "direct" && !conversation.isSelf ? conversation.peer ?? null : null
		const muted = Boolean(conversation.mutedUntil && new Date(conversation.mutedUntil).getTime() > Date.now())
		return [
			{ key: "open", label: t("openChat"), icon: <IChat size={20} />, onSelect: () => setActiveId(conversation.id) },
			...(!conversation.isSelf && conversation.kind !== "direct" ? [{ key: "members", label: t("members"), icon: <IPeople size={20} />, onSelect: later("members") }] : []),
			...(peer && !peer.isBot ? [{ key: "safety", label: t("encryptionVerify"), icon: <IShield size={20} />, onSelect: later("safety") }] : []),
			...(!conversation.isSelf ? [{ key: "mute", label: muted ? t("unmute") : t("notifications"), icon: muted ? <IBell size={20} /> : <IBellOff size={20} />, onSelect: later("mute") }] : []),
			{ key: "gallery", label: t("galleryOpen"), icon: <IGallery size={20} />, onSelect: later("gallery") },
			{ key: "folders", label: t("addToFolder"), icon: <IGallery size={20} />, onSelect: later("folders") },
			...(!conversation.isSelf ? [{ key: "pin", label: pinnedChatSet.has(conversation.id) ? t("unpinChat") : t("pinChat"), icon: <IPin size={20} />, onSelect: () => togglePinChat(conversation.id) }] : []),
			...(!conversation.isSelf ? [{ key: "archive", label: conversation.archivedAt ? t("unarchive") : t("archive"), icon: <IStorage size={20} />, onSelect: later("archive") }] : []),
			...(peer ? [{ key: "remove", label: t("removeFriend"), icon: <ITrash size={20} />, danger: true, onSelect: later("remove") }] : []),
		]
	}

	headerMenuItemsRef.current = headerMenuItems

	return (
		<div className={"app-shell" + (activeId ? " has-active" : "")} style={{ "--sidebar-w": String(sidebarWidth) + "px" } as CSSProperties}>
			<aside className="sidebar">
				<div className="sidebar-header">
					<div className="brand">
						<BrandLogo size={30} />
						<span>FrontierX</span>
					</div>
					<IconButton label={t("friendRequests")} onClick={() => setShowFriends(true)} className="sidebar-header-btn">
						<IPeople />
						{friendRequestCount > 0 ? <Badge count={friendRequestCount} className="icon-badge" /> : null}
					</IconButton>
				</div>
				<div className={"sidebar-search" + (globalOpen ? " open" : "")}>
					<span className="sidebar-search-icon" aria-hidden="true"><ISearch size={18} /></span>
					<input
						ref={globalInputRef}
						type="search"
						className="sidebar-search-input"
						placeholder={t("searchEverywhere")}
						aria-label={t("searchEverywhere")}
						value={globalQuery}
						onFocus={() => setGlobalOpen(true)}
						onChange={(event) => { setGlobalQuery(event.target.value); setGlobalOpen(true) }}
						onKeyDown={(event) => { if (event.key === "Escape") { setGlobalQuery(""); setGlobalOpen(false); event.currentTarget.blur() } }}
					/>
					{globalOpen ? (
						<IconButton label={t("close")} size="s" onClick={() => { setGlobalQuery(""); setGlobalOpen(false) }}>
							<IClose size={18} />
						</IconButton>
					) : null}
				</div>
				{globalOpen ? (
					<GlobalSearch
						query={globalQuery}
						engine={searchEngine}
						conversations={conversations}
						titleOf={convTitle}
						nameOf={nameOf}
						onOpenConversation={openConversationById}
						onOpenMessage={openMessage}
						onStartChat={(person) => void startChatWith(person.username)}
					/>
				) : (
					<>
						<div className="sidebar-actions">
							<button className="button primary new-conv-btn" onClick={() => setShowNew(true)}>
								{t("newConversation")}
							</button>
							<button className="sidebar-filter" aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>
								{showArchived ? t("showActive") : t("showArchived")}
							</button>
						</div>
						<FolderTabs
							folders={folders}
							activeFolderId={activeFolderId}
							allUnread={allUnread}
							folderUnread={folderUnread}
							onSelect={(folderId) => setActiveFolderId(folderId)}
							onManage={() => setShowFolders(true)}
						/>
						<ConversationList
							conversations={orderedConversations}
							activeId={activeId}
							unread={unread}
							pinnedIds={pinnedChatSet}
							mentionIds={mentionChats}
							onlinePeerIds={onlinePeerIds}
							onSelect={(id) => setActiveId(id)}
							onContextMenu={(conversation, x, y) => setChatMenu({ conversation, x, y })}
							emptyLabel={activeFolder ? t("folderEmpty") : t("noChatsYet")}
						/>
					</>
				)}
				<div className="sidebar-user">
					<button type="button" className="sidebar-account" onClick={(event) => setAccountMenu(event.currentTarget)} aria-haspopup="menu" aria-label={t("accountsOnDevice")}>
						<span className="sidebar-account-avatar">
							<Avatar src={user?.avatar} label={user?.displayName || user?.username || "?"} seed={currentUserId} size={40} />
							{otherUnread > 0 ? <Badge count={otherUnread} className="icon-badge" /> : null}
						</span>
						<span className="sidebar-account-text">
							<span className="sidebar-user-name">{user?.displayName ?? user?.username}</span>
							<span className="sidebar-user-sub">@{user?.username}{otherAccounts.length > 0 ? " · " + String(accounts.length) + " " + t("accountsShort") : ""}</span>
						</span>
						<ISwap size={18} />
					</button>
					<IconButton label={t("settings")} variant="tonal" onClick={() => setSettingsPage("home")}>
						<ISettingsGear />
					</IconButton>
				</div>
			</aside>
			<div
				className="sidebar-resizer"
				role="separator"
				aria-orientation="vertical"
				aria-label={t("resizeSidebar")}
				title={t("resizeSidebar")}
				tabIndex={0}
				onPointerDown={startSidebarResize}
				onKeyDown={onSidebarResizeKey}
				onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
			/>
			<main
				className={"main" + (dragOver ? " drag-over" : "")}
				onDragOver={(event) => { if (event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); setDragOver(true) } }}
				onDragLeave={(event) => { if (event.currentTarget === event.target) setDragOver(false) }}
				onDrop={onDropFiles}
			>
				{keys.status === "locked" ? (
					<Banner tone="warning" icon={<ILock />} title={t("keysLockedTitle")} className="main-banner" actions={<Button variant="filled" onClick={() => setUnlockOpen(true)}>{t("unlock")}</Button>}>
						{t("keysLockedCopy")}
					</Banner>
				) : null}
				{keys.status === "error" ? (
					<Banner tone="error" title={t("encryptionSetupFailed")} className="main-banner" actions={<Button variant="tonal" onClick={() => void revalidateKeys()}>{t("tryAgain")}</Button>}>
						{keys.message}
					</Banner>
				) : null}
				{error ? <div className="banner error" onClick={() => setError(null)}>{error}</div> : null}
				{keyPending && activeId ? (
					<Banner tone="info" icon={<IKey />} className="main-banner key-banner" actions={
						<>
							<Button variant="tonal" onClick={() => { const id = activeId; void api.requestKeys(id).then(() => pushToast({ title: t("encryptionTitle"), body: t("keyRequested") })).catch((err) => setError(errMessage(err, t("encryptionSetupFailed")))) }}>{t("keyAskAgain")}</Button>
							{canModerate ? <Button variant="text" onClick={() => { const id = activeId; void ring().mint(id).then(() => { setKeyReady(true); setKeyPending(false); pushToast({ title: t("encryptionTitle"), body: t("keyNewStarted") }) }).catch((err) => setError(errMessage(err, t("encryptionSetupFailed")))) }}>{t("keyStartNew")}</Button> : null}
						</>
					}>
						{t("encryptionWaitingKey")}
					</Banner>
				) : null}
				{activeConversation ? (
					<>
						<header className="thread-header">
							<div className="thread-header-row">
								<button type="button" className="thread-back" aria-label={t("back")} onClick={() => setActiveId(null)}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg></button>
								<button type="button" className="thread-title-wrap" onClick={() => { if (activeConversation.kind !== "direct" && !activeConversation.isSelf) setShowMembers(true); else if (directPeer) setSafetyOpen(true) }}>
									{directPeer ? <Avatar src={directPeer.avatar} label={directPeer.displayName || directPeer.username} seed={directPeer.id} size={40} className="thread-avatar" /> : activeConversation.kind !== "direct" ? <Avatar src={activeConversation.avatar} label={convTitle(activeConversation)} seed={activeConversation.id} size={40} shape={activeConversation.kind === "group" ? "group" : "channel"} className="thread-avatar" /> : null}
									<div>
										<h2 className="thread-title">{convTitle(activeConversation)}{directPeer?.isBot ? <span className="bot-badge"><IBot size={12} /> BOT</span> : null}</h2>
										<p className="thread-sub">
											<span className="tag">{activeConversation.isSelf ? t("savedMessages") : activeConversation.kind === "channel" ? t("kindChannel") : activeConversation.kind === "group" ? t("kindGroup") : directPeer?.isBot ? t("kindBot") : t("kindDirect")}</span>
											{!activeConversation.isSelf && !directPeer?.isBot ? <span className="presence-summary" aria-live="polite"><span className={"presence-dot" + (onlineOtherMemberCount > 0 ? " online" : "")} aria-hidden="true" />{presenceLabel}</span> : null}
											{pinned.length > 0 ? <span className="pin-summary">{pinned.length} {t("pinned")}</span> : null}
											{activeMuted ? <span className="pin-summary">{t("muted")}</span> : null}
											{activeConversation.ttlSeconds ? <span className="pin-summary ttl-summary">{t("ttlShort")} {ttlLabel(activeConversation.ttlSeconds, t)}</span> : null}
										</p>
									</div>
								</button>
								<div className="thread-actions">
									{activeConversation.scheduledCount ? (
										<button type="button" className="scheduled-chip" onClick={() => setShowScheduled(true)} title={t("scheduledTitle")}>
											<ISchedule size={16} />
											<span>{activeConversation.scheduledCount}</span>
										</button>
									) : null}
									<IconButton label={t("searchInChat")} selected={showThreadSearch} onClick={() => { setShowThreadSearch((value) => !value); setSearchQuery("") }}>
										<ISearch />
									</IconButton>
									{!activeConversation.isSelf && activeConversation.kind !== "channel" && !directPeer?.isBot ? (
										<IconButton label={t("call")} onClick={() => void call.startOrJoin(activeConversation.id)} disabled={!canSend || call.activeConversationId === activeConversation.id}>
											<IPhoneCall />
										</IconButton>
									) : null}
									<IconButton label={t("more")} onClick={(event) => setHeaderMenu(event.currentTarget)}>
										<IMore />
									</IconButton>
								</div>
							</div>
						</header>
						{showThreadSearch ? (
							<div className="thread-search">
								<ISearch size={18} />
								<input id="message-search" className="input" type="search" autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t("searchPlaceholder")} aria-label={t("searchInChat")} />
								{searchQuery ? <span className="muted">{filteredDisplay.length} {t("matches")}</span> : null}
							</div>
						) : null}
						{call.activeConversationId === activeConversation.id && call.callId ? <CallBar participantCount={call.participants.length} muted={call.muted} remotes={call.remotes} localStream={call.localStream} onToggleMute={call.toggleMute} sharing={call.sharing} screenStream={call.screenStream} remoteScreens={call.remoteScreens} onToggleShare={call.toggleShare} onLeave={() => void call.leave()} title={convTitle(activeConversation)} avatar={directPeer ? directPeer.avatar : activeConversation.avatar} seed={directPeer ? directPeer.id : activeConversation.id} shape={directPeer ? "circle" : activeConversation.kind === "group" ? "group" : activeConversation.kind === "channel" ? "channel" : "circle"} /> : null}
						<MessageThread
							members={members} messages={filteredDisplay} isSelf={Boolean(activeConversation.isSelf)} readIds={readIds} conversationId={activeConversation.id}
							reactions={reactions}
							currentUserId={currentUserId}
							loading={loadingMessages}
							hasMore={hasMore}
							loadingOlder={loadingOlder}
							typingLabel={typingLabel}
							onLoadOlder={() => void handleLoadOlder()}
							onReply={handleReply} onResolveMedia={resolveMediaUrl}
							onOpenViewer={openViewerForMessage}
							onOpenPinnedList={() => setShowPinnedList(true)}
							jumpToId={jumpToId}
							onJumpHandled={() => setJumpToId(null)}
							onEdit={handleEdit}
							onDelete={(message) => void handleDelete(message)}
							onToggleReaction={(messageId, emoji, active) =>
								void handleToggleReaction(messageId, emoji, active)
							}
							pinnedIds={pinnedIds}
							canModerate={Boolean(canModerate)}
							onTogglePin={(messageId, active) => void handleTogglePin(messageId, active)}
							onForward={(message) => setForwardFor(message)}
							isChannel={activeConversation.kind === "channel"}
							onOpenComments={(message) => void handleOpenComments(message)}
							pending={pendingUploads.filter((item) => item.conversationId === activeConversation.id)}
							queued={outbox.filter((item) => item.conversationId === activeConversation.id)}
							pollsByMessage={pollsByMessage}
							canClosePoll={Boolean(canCloseAnyPoll)}
							onVotePoll={handleVotePoll}
							onClosePoll={handleClosePoll}
							hasNewer={hasNewer}
							loadingNewer={loadingNewer}
							onLoadNewer={() => void handleLoadNewer()}
							onMessageContact={(username) => void startChatWith(username)}
							onBotButton={handleBotButton}
						/>
						<Composer
							disabled={!keyReady || !canSend}
							draft={draft}
							value={composerValue}
							onValueChange={updateComposerValue}
							onSend={handleSend} onAttach={(file, caption, options) => void handleAttach(file, caption, options)}
							onSendSticker={(sticker) => void handleSendSticker(sticker)}
							onSendGif={(url) => void handleSendGif(url)}
							onSendVoice={(recording, options) => void handleSendVoice(recording, options)}
							onSendLocation={(location, options) => void handleSendLocation(location, options)}
							onSendContact={(contact, options) => void handleSendContact(contact, options)}
							mentions={members.filter((member) => member.userId !== currentUserId).map((member) => ({ username: member.username, displayName: member.displayName || member.username }))}
							commands={botCommands}
							dropped={droppedFiles}
							onDroppedHandled={() => setDroppedFiles(null)}
							onSubmitEdit={handleSubmitEdit}
							onTyping={handleTyping}
							onCancelDraft={handleCancelDraft}
							onCreatePoll={(opener) => { pollDialogOpenerRef.current = opener; setShowPollDialog(true) }}
						/>
					</>
				) : (
					<div className="empty">
						<span className="empty-art">
							<MorphBlob className="empty-blob" size={260} shapes={[1, 6, 2, 7, 4]} />
							<svg className="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5a2.5 2.5 0 012.5-2.5h10a2.5 2.5 0 012.5 2.5v7a2.5 2.5 0 01-2.5 2.5h-5.3L7 20v-4a2.5 2.5 0 01-2.5-2.5v-7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>
						</span>
						<h2 className="empty-title">{t("noConversationTitle")}</h2>
						<p className="empty-sub">
							{t("noConversationSub")}
						</p>
					</div>
				)}
			</main>
			{showNew ? (
				<NewConversationDialog onClose={() => setShowNew(false)} onCreated={handleCreated} />
			) : null}
			{dragOver ? <div className="drop-hint" aria-hidden="true"><span>{t("dropFiles")}</span></div> : null}
			{viewerIndex !== null && viewerItems[viewerIndex] ? (
				<MediaViewer
					items={viewerItems}
					index={viewerIndex}
					onIndexChange={(next) => setViewerIndex(next)}
					onClose={() => setViewerIndex(null)}
					onResolveMedia={resolveMediaUrl}
				/>
			) : null}
			{showGallery && activeConversation ? (
				<GalleryDialog
					items={viewerItems}
					onClose={() => setShowGallery(false)}
					onOpen={(index) => { setShowGallery(false); setViewerIndex(index) }}
					onResolveMedia={resolveMediaUrl}
					hasMore={hasMore}
					loadingOlder={loadingOlder}
					onLoadOlder={() => void handleLoadOlder()}
				/>
			) : null}
			{showPinnedList && activeConversation ? (
				<PinnedDialog
					messages={pinnedMessages}
					canModerate={Boolean(canModerate)}
					onClose={() => setShowPinnedList(false)}
					onJump={(messageId) => { setShowPinnedList(false); setJumpToId(messageId) }}
					onUnpin={(messageId) => void handleTogglePin(messageId, false)}
					previewText={messagePreview}
					authorOf={messageAuthor}
				/>
			) : null}
			{showFolders ? (
				<FolderDialog
					folders={folders}
					conversations={folderPickerChats}
					conversationLabel={convTitle}
					onClose={() => setShowFolders(false)}
					onChanged={refreshFolders}
				/>
			) : null}
			{showPollDialog ? <PollDialog opener={pollDialogOpenerRef.current} onClose={() => setShowPollDialog(false)} onCreate={handleCreatePoll} /> : null}
			{incomingCall ? <IncomingCallBanner label={incomingCallLabel} avatar={incomingCallConv ? (incomingCallConv.peer?.avatar ?? incomingCallConv.avatar) : null} seed={incomingCallConv ? (incomingCallConv.peer?.id ?? incomingCallConv.id) : undefined} onAccept={call.acceptIncoming} onDismiss={call.dismissIncoming} /> : null}
			{showMembers ? <MemberDialog members={members} onlineUserIds={onlineUserIds} lastSeen={lastSeen} currentUserId={currentUserId} canManage={Boolean(canModerate)} conversation={activeConversation ?? undefined} onSaveProfile={handleSaveConversationProfile} onClose={() => setShowMembers(false)} onRoleChange={handleRoleChange} onLeave={handleLeaveConversation} onDelete={handleDeleteConversation} onMembersChanged={handleMembersChanged} /> : null}
			{settingsPage && user ? <SettingsSheet user={user} initialPage={settingsPage} onClose={() => setSettingsPage(null)} onUpdated={updateUser} backgroundUnread={backgroundUnread} /> : null}
			{signOutOpen ? <SignOutSheet onClose={() => setSignOutOpen(false)} /> : null}
			{showFriends ? <FriendRequestsDialog onClose={() => { setShowFriends(false); void api.listFriendRequests().then((r) => setFriendRequestCount(r.incoming.length)).catch(() => {}) }} onFriendAccepted={(conversation) => { setConversations((prev) => prev.some((c) => c.id === conversation.id) ? prev : [conversation, ...prev]); setActiveId(conversation.id); setShowFriends(false); void api.listFriendRequests().then((r) => setFriendRequestCount(r.incoming.length)).catch(() => {}) }} /> : null}
			{forwardFor ? <ForwardDialog conversations={conversations} titleOf={convTitle} onClose={() => setForwardFor(null)} onForward={(conversationId) => void handleForward(conversationId)} /> : null}
			{commentsFor ? <CommentsDialog comments={comments} loading={commentsLoading} canComment={canComment} parent={commentsParent} onClose={() => { setCommentsFor(null); setComments([]) }} onPost={handlePostComment} /> : null}
			{showScheduled && activeConversation ? <ScheduledSheet conversationId={activeConversation.id} version={scheduledVersion} onClose={() => setShowScheduled(false)} onSent={appendMessage} /> : null}
			{unlockOpen && keys.status === "locked" ? <KeyUnlockSheet info={keys.info} onClose={() => setUnlockOpen(false)} /> : null}
			{linkRequest && keys.status === "ready" ? <LinkApprovalSheet request={linkRequest} onClose={() => setLinkRequest(null)} /> : null}
			{safetyOpen && directPeer ? <SafetySheet peerName={directPeer.displayName || directPeer.username} peerKey={members.find((member) => member.userId === directPeer.id)?.publicKey ?? null} ownKey={keys.status === "ready" ? keys.session.publicKey : null} onClose={() => setSafetyOpen(false)} /> : null}
			{accountMenu ? <Menu anchor={accountMenu} items={accountMenuItems} onClose={() => setAccountMenu(null)} align="start" placement="above" /> : null}
			{headerMenu ? <Menu anchor={headerMenu} items={headerMenuItems} onClose={() => setHeaderMenu(null)} /> : null}
			{chatMenu ? <Menu anchor={null} point={{ x: chatMenu.x, y: chatMenu.y }} items={chatMenuItems(chatMenu.conversation)} onClose={() => setChatMenu(null)} /> : null}
			{choice === "mute" && activeConversation ? (
				<ChoiceSheet
					title={t("notifications")}
					subtitle={t("muteFor")}
					value={""}
					options={[
						{ value: String(60 * 60 * 1000), label: t("mute1h") },
						{ value: String(8 * 60 * 60 * 1000), label: t("mute8h") },
						{ value: String(2 * 24 * 60 * 60 * 1000), label: t("mute2d") },
						{ value: String(7 * 24 * 60 * 60 * 1000), label: t("mute1w") },
						{ value: String(MUTE_FOREVER_MS), label: t("muteForever") },
					]}
					onPick={(value) => void handleMuteFor(Number(value))}
					onClose={() => setChoice(null)}
				/>
			) : null}
			{choice === "ttl" && activeConversation ? (
				<ChoiceSheet
					title={t("ttlMenu")}
					subtitle={t("ttlCopy")}
					value={String(activeConversation.ttlSeconds ?? 0)}
					options={[
						{ value: "0", label: t("ttlOff") },
						{ value: "3600", label: t("ttl1h") },
						{ value: "86400", label: t("ttl1d") },
						{ value: "604800", label: t("ttl1w") },
						{ value: "2592000", label: t("ttl30d") },
					]}
					onPick={(value) => void handleSetTtl(Number(value) || null)}
					onClose={() => setChoice(null)}
				/>
			) : null}
			{choice === "folders" && activeConversation ? (
				<Sheet title={t("addToFolder")} icon={<IGallery />} iconShape="pentagon" iconTone="teal" onClose={() => setChoice(null)} size="sm">
					<ListGroup>
						{folders.map((folder) => {
							const inFolder = folder.conversationIds.includes(activeConversation.id)
							return <SwitchItem key={folder.id} title={folder.name} checked={inFolder} onChange={(next) => void handleToggleChatFolder(folder.id, activeConversation.id, next)} />
						})}
						<ListItem title={t("manageFolders")} onClick={() => { setChoice(null); setShowFolders(true) }} chevron />
					</ListGroup>
				</Sheet>
			) : null}
			{groupInvites.length > 0 ? (
				<Sheet title={t("groupInviteTitle")} subtitle={groupInvites[0]?.fromName ?? undefined} icon={<IPeople />} iconShape="cookie" iconTone="green" onClose={() => setGroupInvites((prev) => prev.slice(1))} size="sm"
					actions={
						<>
							<Button variant="text" onClick={() => { const inv = groupInvites[0]; if (!inv) return; void api.declineGroupInvite(inv.id).catch(() => {}); setGroupInvites((prev) => prev.filter((gi) => gi.id !== inv.id)) }}>{t("decline")}</Button>
							<Button variant="filled" onClick={() => { const inv = groupInvites[0]; if (!inv) return; void api.acceptGroupInvite(inv.id).then(() => api.listConversations()).then((res) => { setConversations(res.conversations); setActiveId(inv.conversationId); setGroupInvites((prev) => prev.filter((gi) => gi.id !== inv.id)) }).catch(() => setGroupInvites((prev) => prev.filter((gi) => gi.id !== inv.id))) }}>{t("accept")}</Button>
						</>
					}
				>
					<p className="settings-intro">{groupInvites[0]?.conversationTitle || t("groupInviteBody")}</p>
				</Sheet>
			) : null}
			{inviteCode ? (
				<Sheet title={t("inviteJoinTitle")} icon={<IPeople />} iconShape="clover" iconTone="green" onClose={() => setInviteCode(null)} size="sm"
					actions={
						<>
							<Button variant="text" onClick={() => setInviteCode(null)}>{t("cancel")}</Button>
							<Button variant="filled" onClick={() => { if (!inviteCode) return; const code = inviteCode; setInviteCode(null); void api.joinByInvite(code).then((joinRes) => { setConversations((prev) => prev.some((c) => c.id === joinRes.conversation.id) ? prev : [joinRes.conversation, ...prev]); setActiveId(joinRes.conversation.id) }).catch((joinErr) => setError(errMessage(joinErr, tt("joinInviteFailed")))) }}>{t("join")}</Button>
						</>
					}
				>
					<p className="settings-intro">{t("inviteJoinBody")}</p>
				</Sheet>
			) : null}
			{confirmRemoveFriend && directPeer ? (
				<Sheet title={t("removeFriendConfirm")} icon={<ITrash />} iconShape="burst" iconTone="error" onClose={() => setConfirmRemoveFriend(false)} size="sm" role="alertdialog"
					actions={
						<>
							<Button variant="text" onClick={() => setConfirmRemoveFriend(false)}>{t("cancel")}</Button>
							<Button variant="danger" onClick={() => { if (!directPeer) return; const pid = directPeer.id; setConfirmRemoveFriend(false); void api.removeFriend(pid).then(() => { setConversations((prev) => prev.filter((c) => !(c.peer && c.peer.id === pid))); setActiveId(null) }).catch((remErr) => setError(errMessage(remErr, tt("removeFriendFailed")))) }}>{t("removeFriend")}</Button>
						</>
					}
				>
					<p className="settings-intro">{directPeer.displayName || directPeer.username}</p>
				</Sheet>
			) : null}
		</div>
	)
}
