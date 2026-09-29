import type {
	AuthResult,
	Conversation,
	FileAsset,
	Member,
	MessageEnvelope,
	Reaction,
	ReceiptState,
	Replica,
	User,
	ConversationMember,
	WrappedKeyEntry,
	PinnedMessage,
	MemberRole,
	ConversationDraft,
	SessionDevice,
	ConversationFolder,
	SavedMessage,
	PollSummary,
	CallState,
	FriendRequest,
	Sticker,
Friend,
UserSummary,
KeyStateResponse,
SealedValue,
SlotInput,
StoredSlotInfo,
VaultItem,
VaultItemInput,
ShareInfo,
ShareInput,
MissingShare,
ConversationKeysResponse,
LinkRequestInfo,
ScheduledMessage,
BotInfo,
BotCommand,
	UserPrivacySettings,
	PrivacyPolicy,
	PrivacyScope,
	PrivacyMode,
} from "./types"
import { getToken } from "./session"

let BASE = ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE as string | undefined) ?? ""

// Tests (and tools) talk to a server on another origin.
export function setApiBase(base: string): void {
	BASE = base
}

export class ApiError extends Error {
	status: number
	constructor(status: number, message: string) {
		super(message)
		this.name = "ApiError"
		this.status = status
	}
}

// A request answered 401 means the session is gone (signed out elsewhere,
// password reset, expired). The auth layer listens and shows the sign-in
// screen for that account instead of leaving every screen failing.
export const UNAUTHORIZED_EVENT = "frontierx:unauthorized"

async function request<T>(path: string, method: string, body?: unknown, tokenOverride?: string | null): Promise<T> {
	const headers: Record<string, string> = {}
	const token = tokenOverride === undefined ? getToken() : tokenOverride
	if (token) headers["authorization"] = "Bearer " + token
	if (body !== undefined) headers["content-type"] = "application/json"
	const res = await fetch(BASE + path, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await res.text()
	let data: any = {}
	if (text) {
		try {
			data = JSON.parse(text)
		} catch {
			// A proxy error page or a cut connection is not JSON.
			if (res.ok) throw new ApiError(res.status, "Request failed")
		}
	}
	if (!res.ok) {
		const message = data && typeof data.error === "string" ? data.error : "Request failed"
		if (res.status === 401 && token && tokenOverride === undefined && !path.startsWith("/api/auth/") && message !== "invalid credentials") {
			try {
				window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { token } }))
			} catch {
				// not in a browser
			}
		}
		const error = new ApiError(res.status, message)
		;(error as ApiError & { data?: unknown }).data = data
		throw error
	}
	return data as T
}

export const api = {
	deleteAccount(input: { password: string }) {
		return request<{ deleted: boolean; conversationsDeleted: number }>("/api/me/delete", "POST", input)
	},
	register(input: { username: string; password: string; displayName?: string; email?: string; publicKey?: string; deviceId?: string }) {
		return request<RegisterResult>("/api/auth/register", "POST", input)
	},
	login(input: { username: string; password: string; deviceId?: string }) {
		return request<AuthResult>("/api/auth/login", "POST", input)
	},
	me() {
		return request<{ user: User }>("/api/me", "GET")
	},
	updateProfile(input: { displayName: string }) {
		return request<{ user: User }>("/api/me/profile", "POST", input)
	},
	listSessions() {
		return request<{ sessions: SessionDevice[]; currentSessionId: string }>("/api/me/sessions", "GET")
	},
	revokeSession(sessionId: string) {
		return request<{ revoked: true; currentSessionRevoked: boolean }>("/api/me/sessions/" + sessionId + "/revoke", "POST", {})
	},
	revokeOtherSessions() {
		return request<{ revoked: number }>("/api/me/sessions/revoke-others", "POST", {})
	},
	listSavedMessages() { return request<{ saved: SavedMessage[] }>("/api/me/saved-messages", "GET") },
	listConversationFolders() { return request<{ folders: ConversationFolder[] }>("/api/me/folders", "GET") },
	createConversationFolder(name: string) { return request<{ folder: ConversationFolder }>("/api/me/folders", "POST", {name}) },
	deleteConversationFolder(folderId: string) { return request<{ ok: true }>("/api/me/folders/"+folderId+"/delete", "POST", {}) },
	setFolderConversation(folderId: string, conversationId: string, active: boolean) { return request<{ ok: true; active: boolean }>("/api/me/folders/"+folderId+"/conversations", "POST", {conversationId,active}) },
	linkPreview(url: string) {
		return request<{ preview: { url: string; title: string | null; description: string | null; imageUrl: string | null; siteName: string | null } }>(
			"/api/link-preview?url=" + encodeURIComponent(url),
			"GET",
		)
	},
	async linkPreviewImage(url: string): Promise<Blob | null> {
		const token = getToken()
		const headers: Record<string, string> = {}
		if (token) headers.authorization = "Bearer " + token
		const res = await fetch(BASE + "/api/link-preview/image?url=" + encodeURIComponent(url), { method: "GET", headers })
		if (!res.ok) return null
		return res.blob()
	},
	listConversations() {
		return request<{ conversations: Conversation[] }>("/api/conversations", "GET")
	},
	createConversation(input: { kind: string; title?: string; memberUsernames?: string[] }) {
		return request<{ conversation: Conversation; members: Member[] }>(
			"/api/conversations",
			"POST",
			input,
		)
	},
	archiveConversation(conversationId: string, archived: boolean) {
		return request<{ conversationId: string; archivedAt: string | null }>(
			"/api/conversations/" + conversationId + "/archive",
			"POST",
			{ archived },
		)
	},
	setConversationTtl(conversationId: string, seconds: number | null) { return request<{ conversationId: string; ttlSeconds: number | null }>("/api/conversations/" + conversationId + "/ttl", "POST", { seconds }) },
	setConversationMuted(conversationId: string, mutedUntil: string | null) { return request<{ conversationId: string; mutedUntil: string | null }>("/api/conversations/"+conversationId+"/mute", "POST", {mutedUntil}) },
	getConversationDraft(conversationId: string) {
		return request<{ draft: ConversationDraft | null }>("/api/conversations/" + conversationId + "/draft", "GET")
	},
	saveConversationDraft(conversationId: string, ciphertext: string | null) {
		return request<{ draft: ConversationDraft | null }>("/api/conversations/" + conversationId + "/draft", "POST", { ciphertext })
	},
	listMessages(conversationId: string, opts: { limit?: number; before?: string | null } = {}) {
		const params = new URLSearchParams()
		if (opts.limit) params.set("limit", String(opts.limit))
		if (opts.before) params.set("before", opts.before)
		const query = params.toString()
		return request<{ messages: MessageEnvelope[]; hasMore: boolean; hasNewer?: boolean }>(
			"/api/conversations/" + conversationId + "/messages" + (query ? "?" + query : ""),
			"GET",
		)
	},
	sendMessage(conversationId: string, input: { ciphertext: string; replyTo?: string | null; silent?: boolean }) {
		return request<{ message: MessageEnvelope }>(
			"/api/conversations/" + conversationId + "/messages",
			"POST",
			input,
		)
	},
	editMessage(conversationId: string, messageId: string, input: { ciphertext: string }) {
		return request<{ message: MessageEnvelope }>(
			"/api/conversations/" + conversationId + "/messages/" + messageId + "/edit",
			"POST",
			input,
		)
	},
	deleteMessage(conversationId: string, messageId: string) {
		return request<{ ok: true }>(
			"/api/conversations/" + conversationId + "/messages/" + messageId + "/delete",
			"POST",
			{},
		)
	},
	setSavedMessage(conversationId: string, messageId: string, active: boolean) { return request<{ ok: true; savedAt: string | null }>("/api/conversations/"+conversationId+"/messages/"+messageId+"/save", "POST", {active}) },
	listPolls(conversationId: string) { return request<{ polls: PollSummary[] }>("/api/conversations/" + conversationId + "/polls", "GET") },
	createPoll(conversationId: string, input: { ciphertext: string; optionCount: number; multipleChoice: boolean; quiz: boolean; silent?: boolean }) { return request<{ message: MessageEnvelope; poll: PollSummary }>("/api/conversations/" + conversationId + "/polls", "POST", input) },
	votePoll(conversationId: string, messageId: string, optionIndexes: number[]) { return request<{ poll: PollSummary }>("/api/conversations/" + conversationId + "/polls/" + messageId + "/vote", "POST", { optionIndexes }) },
	closePoll(conversationId: string, messageId: string) { return request<{ poll: PollSummary }>("/api/conversations/" + conversationId + "/polls/" + messageId + "/close", "POST", {}) },
	setReaction(conversationId: string, messageId: string, input: { emoji: string; active: boolean }) {
		return request<{ ok: true }>(
			"/api/conversations/" + conversationId + "/messages/" + messageId + "/reactions",
			"POST",
			input,
		)
	},
	listReactions(conversationId: string) {
		return request<{ reactions: Reaction[] }>(
			"/api/conversations/" + conversationId + "/reactions",
			"GET",
		)
	},
	listPinnedMessages(conversationId: string) {
		return request<{ pinned: PinnedMessage[] }>("/api/conversations/" + conversationId + "/pinned", "GET")
	},
	setPinnedMessage(conversationId: string, messageId: string, active: boolean) {
		return request<{ ok: true; pinnedAt: string | null }>(
			"/api/conversations/" + conversationId + "/messages/" + messageId + "/pin",
			"POST",
			{ active },
		)
	},
	sendTyping(conversationId: string) {
		return request<{ ok: true }>("/api/conversations/" + conversationId + "/typing", "POST", {})
	},
	listReceipts(conversationId: string) {
		return request<{ receipts: Array<{ messageId: string; userId: string; state: ReceiptState; at: string }> }>("/api/conversations/" + conversationId + "/receipts", "GET")
	},
	sendReceipt(conversationId: string, input: { messageId: string; state?: ReceiptState }) {
		return request<{ ok: true }>(
			"/api/conversations/" + conversationId + "/receipts",
			"POST",
			input,
		)
	},
	createFile(input: {
		conversationId: string
		name: string
		mime: string
		size: number
		manifest?: unknown
	}) {
		return request<{ asset: FileAsset; replica: Replica }>("/api/files", "POST", input)
	},
	listFiles(conversationId: string) {
		return request<{ files: Array<{ asset: FileAsset; replica: Replica }> }>(
			"/api/conversations/" + conversationId + "/files",
			"GET",
		)
	},
	getFile(fileId: string) {
		return request<{ asset: FileAsset; replica: Replica }>("/api/files/" + fileId, "GET")
	},
	// XMLHttpRequest rather than fetch: it is the only way to follow how much of
	// the body has actually gone out, which a chat needs to show while a large
	// attachment uploads. A Blob body streams from disk instead of the heap.
	uploadFileBlob(fileId: string, body: Uint8Array | Blob, onProgress?: (ratio: number) => void): Promise<{ ok: boolean; bytes: number }> {
		const token = getToken()
		const payload = body instanceof Blob ? body : new Blob([body as BlobPart])
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest()
			xhr.open("POST", BASE + "/api/files/" + fileId + "/blob", true)
			xhr.setRequestHeader("content-type", "application/octet-stream")
			if (token) xhr.setRequestHeader("authorization", "Bearer " + token)
			if (onProgress) {
				xhr.upload.onprogress = (event) => {
					if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total))
				}
			}
			xhr.onload = () => {
				let data: { ok?: boolean; bytes?: number; error?: string } = {}
				try {
					data = xhr.responseText ? JSON.parse(xhr.responseText) : {}
				} catch {
					data = {}
				}
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve({ ok: Boolean(data.ok), bytes: Number(data.bytes ?? 0) })
					return
				}
				reject(new ApiError(xhr.status, data.error ? data.error : "Upload failed"))
			}
			xhr.onerror = () => reject(new ApiError(0, "Upload failed"))
			xhr.ontimeout = () => reject(new ApiError(0, "Upload timed out"))
			xhr.onabort = () => reject(new ApiError(0, "Upload cancelled"))
			xhr.send(payload)
		})
	},
	// onProgress reports 0..1 while the ciphertext streams in, so a video bubble
	// can show how far along it is. It is only called when the server sends a
	// content length; otherwise the download simply completes.
	async downloadFileBlob(fileId: string, onProgress?: (ratio: number) => void): Promise<Uint8Array> {
		const token = getToken()
		const headers: Record<string, string> = {}
		if (token) headers.authorization = "Bearer " + token
		const res = await fetch(BASE + "/api/files/" + fileId + "/blob", { method: "GET", headers })
		if (!res.ok) {
			const detail = await res.text()
			throw new ApiError(res.status, detail || "Download failed")
		}
		const total = Number(res.headers.get("content-length") ?? 0)
		if (!onProgress || !res.body || !Number.isFinite(total) || total <= 0) {
			const buffer = await res.arrayBuffer()
			return new Uint8Array(buffer)
		}
		const reader = res.body.getReader()
		const chunks: Uint8Array[] = []
		let received = 0
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value) continue
			chunks.push(value)
			received += value.length
			onProgress(Math.min(1, received / total))
		}
		const merged = new Uint8Array(received)
		let offset = 0
		for (const chunk of chunks) {
			merged.set(chunk, offset)
			offset += chunk.length
		}
		return merged
	},
	fileBackupBegin(fileId: string) {
		return request<{ replica: Replica }>("/api/files/" + fileId + "/backup/begin", "POST")
	},
	fileBackupComplete(fileId: string) {
		return request<{ replica: Replica }>("/api/files/" + fileId + "/backup/complete", "POST")
	},
	fileBackupFail(fileId: string) {
		return request<{ replica: Replica }>("/api/files/" + fileId + "/backup/fail", "POST")
	},
	fileRestoreBegin(fileId: string) {
		return request<{ replica: Replica }>("/api/files/" + fileId + "/restore/begin", "POST")
	},
	fileRestoreComplete(fileId: string) {
		return request<{ replica: Replica }>("/api/files/" + fileId + "/restore/complete", "POST")
	},
	fileRestoreFail(fileId: string) {
		return request<{ replica: Replica }>("/api/files/" + fileId + "/restore/fail", "POST")
	},
	fileMarkLost(fileId: string) {
		return request<{ replica: Replica }>("/api/files/" + fileId + "/lost", "POST")
	},
	getKeyBackup() {
		return request<{ backup: { salt: string; iv: string; ciphertext: string; iterations: number; publicKey: string } | null }>("/api/me/keybackup", "GET")
	},
	putKeyBackup(backup: { salt: string; iv: string; ciphertext: string; iterations: number; publicKey: string }) {
		return request<{ ok: true }>("/api/me/keybackup", "POST", backup)
	},
	publishPublicKey(publicKey: string) {
		return request<{ ok: true }>("/api/me/publicKey", "POST", { publicKey })
	},
	getConversationMembers(conversationId: string) {
		return request<{ members: ConversationMember[] }>(
			"/api/conversations/" + conversationId + "/members",
			"GET",
		)
	},
	// lastSeen: when members you may see were last online, by user id.
	getConversationPresence(conversationId: string) {
		return request<{ onlineUserIds: string[]; lastSeen?: Record<string, string> }>(
			"/api/conversations/" + conversationId + "/presence",
			"GET",
		)
	},
	setMemberRole(conversationId: string, memberId: string, role: MemberRole) {
		return request<{ member: Member }>(
			"/api/conversations/" + conversationId + "/members/" + memberId + "/role",
			"POST",
			{ role },
		)
	},
	putConversationKeys(conversationId: string, entries: WrappedKeyEntry[], rotate?: boolean) {
		return request<{ ok: true; count: number }>(
			"/api/conversations/" + conversationId + "/keys",
			"POST",
			{ entries, rotate: rotate === true },
		)
	},
	resetMyConversationKey(conversationId: string) {
		return request<{ ok: true }>(
			"/api/conversations/" + conversationId + "/keys/reset",
			"POST",
		)
	},
	getMyConversationKey(conversationId: string) {
		return request<{ entry: WrappedKeyEntry | null }>(
			"/api/conversations/" + conversationId + "/keys/mine",
			"GET",
		)
	},
	getConversationKeyStatus(conversationId: string) {
		return request<{ memberIds: string[]; hasKeys: boolean; mine: boolean }>(
			"/api/conversations/" + conversationId + "/keys/status",
			"GET",
		)
	},
	getCall(conversationId: string) {
		return request<{ call: CallState | null; iceServers: RTCIceServer[] }>(
			"/api/conversations/" + conversationId + "/call",
			"GET",
		)
	},
	joinCall(conversationId: string) {
		return request<{ call: CallState; iceServers: RTCIceServer[] }>(
			"/api/conversations/" + conversationId + "/call/join",
			"POST",
			{},
		)
	},
	leaveCall(conversationId: string, callId: string) {
		return request<{ ok: true }>(
			"/api/conversations/" + conversationId + "/call/leave",
			"POST",
			{ callId },
		)
	},
	setMyAvatar(avatar: string | null) { return request<{ user: User }>("/api/me/avatar", "POST", { avatar }) },
	setConversationProfile(conversationId: string, input: { title?: string; avatar?: string | null }) { return request<{ conversation: Conversation }>("/api/conversations/" + conversationId + "/profile", "POST", input) },
	listFriendRequests() { return request<{ incoming: FriendRequest[]; outgoing: FriendRequest[] }>("/api/friends/requests", "GET") },
	sendFriendRequest(username: string) { return request<{ status: string; conversation?: Conversation; requestId?: string }>("/api/friends/requests", "POST", { username }) },
	acceptFriendRequest(requestId: string) { return request<{ conversation: Conversation }>("/api/friends/requests/" + requestId + "/accept", "POST", {}) },
	declineFriendRequest(requestId: string) { return request<{ ok: true }>("/api/friends/requests/" + requestId + "/decline", "POST", {}) },
listFriends() { return request<{ friends: Friend[] }>("/api/friends", "GET") },
removeFriend(userId: string) { return request<{ ok: true }>("/api/friends/" + userId + "/remove", "POST", {}) },
	getSettings() { return request<UserPrivacySettings>("/api/me/settings", "GET") },
	// --- key system v2 ---
	keyState() { return request<KeyStateResponse>("/api/keys/state", "GET") },
	createAccountKey(input: { password?: string; publicKey?: string; check: SealedValue; slots: SlotInput[]; vault: VaultItemInput[] }) { return request<KeyStateResponse>("/api/keys/account", "POST", input) },
	resetAccountKeys(input: { password: string; publicKey: string; check: SealedValue; slots: SlotInput[]; vault: VaultItemInput[] }) { return request<KeyStateResponse>("/api/keys/reset", "POST", input) },
	replaceIdentity(input: { password: string; publicKey: string; identity: VaultItemInput; slot: SlotInput }) { return request<KeyStateResponse>("/api/keys/identity", "POST", input) },
	putKeySlot(slot: SlotInput & { password?: string }) { return request<{ slots: StoredSlotInfo[] }>("/api/keys/slots", "POST", slot) },
	deleteKeySlot(id: string) { return request<{ slots: StoredSlotInfo[] }>("/api/keys/slots/" + encodeURIComponent(id) + "/delete", "POST", {}) },
	listVault(query: { conversationId?: string; scope?: "identity" | "cek" } = {}) {
		const params = new URLSearchParams()
		if (query.conversationId) params.set("conversationId", query.conversationId)
		if (query.scope) params.set("scope", query.scope)
		const tail = params.toString()
		return request<{ items: VaultItem[] }>("/api/keys/vault" + (tail ? "?" + tail : ""), "GET")
	},
	putVault(items: VaultItemInput[]) { return request<{ added: number }>("/api/keys/vault", "POST", { items }) },
	listMyShares() { return request<{ shares: Array<ShareInfo & { conversationId: string }> }>("/api/keys/shares", "GET") },
	listPendingShares() { return request<{ missing: MissingShare[] }>("/api/keys/pending", "GET") },
	conversationKeys(conversationId: string) { return request<ConversationKeysResponse>("/api/conversations/" + conversationId + "/keys", "GET") },
	createKeyEpoch(conversationId: string, input: { keyId: string; expectedCurrentKeyId: string | null; check: string; shares: ShareInput[] }) { return request<{ currentKeyId: string }>("/api/conversations/" + conversationId + "/keys/epochs", "POST", input) },
	putShares(conversationId: string, shares: ShareInput[]) { return request<{ added: number }>("/api/conversations/" + conversationId + "/keys/shares", "POST", { shares }) },
	rejectShare(conversationId: string, keyId: string) { return request<{ removed: boolean }>("/api/conversations/" + conversationId + "/keys/reject", "POST", { keyId }) },
	requestKeys(conversationId: string) { return request<{ ok: true }>("/api/conversations/" + conversationId + "/keys/request", "POST", {}) },
	startLink(input: { ephemeralPublicKey: string; label: string }) { return request<{ id: string; expiresAt: string }>("/api/keys/link", "POST", input) },
	pollLink(id: string) { return request<{ status: "pending" | "approved" | "denied"; response: { ephemeralPublicKey: string; iv: string; ciphertext: string } | null }>("/api/keys/link/" + encodeURIComponent(id), "GET") },
	pendingLinks() { return request<{ requests: LinkRequestInfo[] }>("/api/keys/link/pending", "GET") },
	approveLink(id: string, response: { ephemeralPublicKey: string; iv: string; ciphertext: string }) { return request<{ ok: true }>("/api/keys/link/" + encodeURIComponent(id) + "/approve", "POST", response) },
	denyLink(id: string) { return request<{ ok: true }>("/api/keys/link/" + encodeURIComponent(id) + "/deny", "POST", {}) },
	changePassword(input: { currentPassword: string; newPassword: string; passwordSlot: SlotInput | null; legacyBackup?: { salt: string; iv: string; ciphertext: string; iterations: number; publicKey: string } | null; signOutOthers?: boolean }) {
		return request<{ ok: true; revoked: number }>("/api/me/password", "POST", input)
	},
	// --- scheduled and silent messages ---
	listScheduled(conversationId: string) { return request<{ scheduled: ScheduledMessage[] }>("/api/conversations/" + conversationId + "/scheduled", "GET") },
	scheduleMessage(conversationId: string, input: { ciphertext: string; sendAt: string; replyTo?: string | null; silent?: boolean }) { return request<{ scheduled: ScheduledMessage }>("/api/conversations/" + conversationId + "/scheduled", "POST", input) },
	updateScheduled(conversationId: string, id: string, input: { ciphertext?: string; sendAt?: string; silent?: boolean }) { return request<{ scheduled: ScheduledMessage }>("/api/conversations/" + conversationId + "/scheduled/" + id + "/update", "POST", input) },
	deleteScheduled(conversationId: string, id: string) { return request<{ ok: true }>("/api/conversations/" + conversationId + "/scheduled/" + id + "/delete", "POST", {}) },
	sendScheduledNow(conversationId: string, id: string) { return request<{ message: MessageEnvelope | null }>("/api/conversations/" + conversationId + "/scheduled/" + id + "/send-now", "POST", {}) },
	// --- search ---
	searchCorpus(opts: { before?: string | null; limit?: number; conversationId?: string } = {}) {
		const params = new URLSearchParams()
		if (opts.before) params.set("before", opts.before)
		if (opts.limit) params.set("limit", String(opts.limit))
		if (opts.conversationId) params.set("conversationId", opts.conversationId)
		return request<{ messages: MessageEnvelope[]; nextBefore: string | null }>("/api/search/messages?" + params.toString(), "GET")
	},
	messagesAround(conversationId: string, messageId: string, limit = 60) {
		return request<{ messages: MessageEnvelope[]; hasMore: boolean; hasNewer: boolean }>("/api/conversations/" + conversationId + "/messages?around=" + encodeURIComponent(messageId) + "&limit=" + limit, "GET")
	},
	messagesAfter(conversationId: string, messageId: string, limit = 50) {
		return request<{ messages: MessageEnvelope[]; hasMore: boolean; hasNewer: boolean }>("/api/conversations/" + conversationId + "/messages?after=" + encodeURIComponent(messageId) + "&limit=" + limit, "GET")
	},
	// --- bots ---
	listBots() { return request<{ bots: BotInfo[] }>("/api/bots", "GET") },
	createBot(input: { username: string; displayName: string; description?: string }) { return request<{ bot: BotInfo; token: string }>("/api/bots", "POST", input) },
	updateBot(id: string, input: { displayName?: string; description?: string | null; allowGroups?: boolean; commands?: BotCommand[] }) { return request<{ bot: BotInfo }>("/api/bots/" + id + "/update", "POST", input) },
	setBotAvatar(id: string, avatar: string | null) { return request<{ bot: BotInfo }>("/api/bots/" + id + "/avatar", "POST", { avatar }) },
	// A button under a bot's message was pressed; data is sealed with the chat key.
	botCallback(conversationId: string, messageId: string, data: string) { return request<{ callbackId: string }>("/api/conversations/" + conversationId + "/messages/" + messageId + "/callback", "POST", { data }) },
	botProfile(userId: string) { return request<{ id: string; username: string; displayName: string; description: string | null; commands: BotCommand[] }>("/api/bots/profile/" + encodeURIComponent(userId), "GET") },
	rotateBotToken(id: string) { return request<{ token: string }>("/api/bots/" + id + "/token", "POST", {}) },
	deleteBot(id: string) { return request<{ ok: true }>("/api/bots/" + id + "/delete", "POST", {}) },
	// --- web push ---
	vapidKey() { return request<{ publicKey: string }>("/api/push/vapid", "GET") },
	registerWebPush(input: { endpoint: string; p256dh: string; auth: string; deviceId: string }, token?: string | null) { return request<{ ok: true }>("/api/me/push/webpush", "POST", input, token) },
	unregisterWebPush(endpoint: string, token?: string | null) { return request<{ ok: true }>("/api/me/push/webpush/delete", "POST", { endpoint }, token) },
	// A background account's own view (unread counts, names) uses its token.
	listConversationsAs(token: string) { return request<{ conversations: Conversation[] }>("/api/conversations", "GET", undefined, token) },
	meAs(token: string) { return request<{ user: User }>("/api/me", "GET", undefined, token) },
	setSettings(input: { requireInvite?: boolean; ghostMode?: boolean; lastSeenPolicy?: PrivacyPolicy; seenTimePolicy?: PrivacyPolicy; callsPolicy?: PrivacyPolicy }) {
		return request<UserPrivacySettings>("/api/me/settings", "POST", input)
	},
	setPrivacyException(targetId: string, scope: PrivacyScope, mode: PrivacyMode | null) {
		return request<UserPrivacySettings>("/api/me/privacy/exceptions", "POST", { targetId, scope, mode })
	},
	setGhostMode(ghostMode: boolean) { return request<{ requireInvite: boolean; ghostMode: boolean }>("/api/me/settings", "POST", { ghostMode }) },
	getPresence() { return request<{ onlineUserIds: string[]; lastSeen?: Record<string, string> }>("/api/presence", "GET") },
	listGroupInvites() { return request<{ invites: Array<{ id: string; conversationId: string; conversationTitle: string | null; conversationKind: string; fromUser: string; fromName: string | null; createdAt: string }> }>("/api/group-invites", "GET") },
	acceptGroupInvite(id: string) { return request<{ ok: true }>("/api/group-invites/" + id + "/accept", "POST", {}) },
	declineGroupInvite(id: string) { return request<{ ok: true }>("/api/group-invites/" + id + "/decline", "POST", {}) },
searchUsers(query: string) { return request<{ users: UserSummary[] }>("/api/users/search?q=" + encodeURIComponent(query), "GET") },
addConversationMembers(conversationId: string, usernames: string[]) { return request<{ members: ConversationMember[] }>("/api/conversations/" + conversationId + "/members/add", "POST", { usernames }) },
leaveConversation(conversationId: string) { return request<{ ok: true }>("/api/conversations/" + conversationId + "/leave", "POST", {}) },
deleteConversation(conversationId: string) { return request<{ ok: true }>("/api/conversations/" + conversationId + "/delete", "POST", {}) },
createInvite(conversationId: string, expiresInSeconds: number | null = null) { return request<{ code: string; expiresAt: string | null }>("/api/conversations/" + conversationId + "/invite", "POST", { expiresInSeconds }) },
inviteInfo(code: string) { return request<{ code: string; kind: string; title: string | null; avatar: string | null; expiresAt: string | null }>("/api/invites/" + code, "GET") },
joinByInvite(code: string) { return request<{ conversation: Conversation }>("/api/invites/" + code + "/join", "POST", {}) },
	listStickers() { return request<{ stickers: Sticker[] }>("/api/me/stickers", "GET") },
	createSticker(data: string) { return request<{ sticker: Sticker }>("/api/me/stickers", "POST", { data }) },
	deleteSticker(stickerId: string) { return request<{ ok: true }>("/api/me/stickers/" + stickerId + "/delete", "POST", {}) },
	listComments(conversationId: string, messageId: string) { return request<{ comments: MessageEnvelope[] }>("/api/conversations/" + conversationId + "/messages/" + messageId + "/comments", "GET") },
	postComment(conversationId: string, messageId: string, input: { ciphertext: string }) { return request<{ message: MessageEnvelope }>("/api/conversations/" + conversationId + "/messages/" + messageId + "/comments", "POST", input) },
	sendCallSignal(conversationId: string, input: { callId: string; to: string; data: unknown }) {
		return request<{ ok: true }>(
			"/api/conversations/" + conversationId + "/call/signal",
			"POST",
			input,
		)
	},
	getEmailState() { return request<EmailState>("/api/me/email", "GET") },
	startEmailAttach(email: string) { return request<{ ok: true; email: string; ttlMinutes: number; sent?: boolean }>("/api/me/email/start", "POST", { email }) },
	confirmEmailAttach(code: string) { return request<{ email: string; verifiedAt: string }>("/api/me/email/verify", "POST", { code }) },
	removeEmail() { return request<{ email: string | null; verifiedAt: string | null }>("/api/me/email/remove", "POST", {}) },
	requestPasswordReset(email: string) { return request<{ ok: true; ttlMinutes: number }>("/api/auth/password/forgot", "POST", { email }) },
	resetPassword(input: { email: string; code: string; password: string }) { return request<{ ok: true }>("/api/auth/password/reset", "POST", input) },
	registerPush(endpoint: string, deviceId: string) { return request<{ ok: true }>("/api/me/push/register", "POST", { endpoint, deviceId }) },
	unregisterPush(endpoint: string, deviceId: string) { return request<{ ok: true }>("/api/me/push/unregister", "POST", { endpoint, deviceId }) },
	sendTestPush() { return request<{ delivered: number; endpoints: number }>("/api/me/push/test", "POST", {}) },
	latestRelease(platform: string, version: string) { return request<{ latest: ReleaseInfo | null; updateAvailable: boolean }>("/api/updates/latest?platform=" + encodeURIComponent(platform) + "&version=" + encodeURIComponent(version), "GET") },
}

export type RegisterResult = AuthResult & {
	email?: { pending: string | null; sent: boolean; error: string | null }
	emailTtlMinutes?: number
}

export type EmailState = {
	email: string | null
	verifiedAt: string | null
	pending: { email: string; expiresAt: string } | null
	mailerEnabled: boolean
}

export type ReleaseInfo = {
	version: string
	versionCode: number
	url: string
	size: number
	sha256: string
	notes: string
	mandatory: boolean
}
