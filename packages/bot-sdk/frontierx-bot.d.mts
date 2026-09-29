// Types for frontierx-bot.mjs.

export declare const SDK_VERSION: string

export interface BotOptions {
	token?: string
	baseUrl?: string
	stateFile?: string
	pollTimeout?: number
	logger?: Pick<Console, "info" | "error">
}

export interface Sender {
	id: string
	username?: string | null
	displayName?: string | null
	isBot?: boolean
}

export interface MessageEnvelope {
	id: string
	conversationId: string
	senderId: string
	ciphertext: string
	replyTo: string | null
	createdAt: string
	editedAt: string | null
	deletedAt: string | null
	silent?: boolean
}

export interface Media {
	kind: "image" | "file" | "voice"
	fileId: string
	name: string
	mime: string
	size: number
	key: string
	manifest: unknown
	caption?: string
	duration?: number
	width?: number
	height?: number
	spoiler?: boolean
}

export interface Location {
	lat: number
	lon: number
	accuracy?: number | null
	label?: string | null
}

export interface Contact {
	displayName: string
	userId?: string | null
	username?: string | null
	phone?: string | null
	email?: string | null
}

export interface Button {
	text: string
	data?: string
	url?: string
}

export interface SendOptions {
	replyTo?: string | null
	silent?: boolean
	buttons?: Button[][]
}

export interface CallbackContext {
	bot: FrontierXBot
	update: Record<string, unknown>
	callbackId: string
	conversationId: string
	messageId: string
	from: Sender | null
	data: string
	match: RegExpExecArray | null
	answer(text?: string, options?: { alert?: boolean }): Promise<void>
	edit(text: string, options?: { buttons?: Button[][] }): Promise<MessageEnvelope>
	reply(text: string, options?: SendOptions): Promise<MessageEnvelope>
	send(text: string, options?: SendOptions): Promise<MessageEnvelope>
}

export interface MessageContext {
	bot: FrontierXBot
	update: Record<string, unknown>
	conversationId: string
	conversation: { id: string; kind: string; title: string | null } | null
	message: MessageEnvelope
	sender: Sender
	edited: boolean
	kind: "text" | "media" | "location" | "contact"
	text: string
	media?: Media
	location?: Location
	contact?: Contact
	command?: string
	args?: string
	buttons: Button[][] | null
	reply(text: string, options?: { silent?: boolean; buttons?: Button[][] }): Promise<MessageEnvelope>
	send(text: string, options?: SendOptions): Promise<MessageEnvelope>
	typing(): Promise<unknown>
	download(): Promise<Uint8Array>
	replyWithFile(input: FileInput, options?: FileOptions): Promise<MessageEnvelope>
	replyWithPhoto(input: FileInput, options?: FileOptions): Promise<MessageEnvelope>
	replyWithVideo(input: FileInput, options?: FileOptions): Promise<MessageEnvelope>
}

export type FileInput = string | Uint8Array | ArrayBuffer

export interface FileOptions extends SendOptions {
	name?: string
	mime?: string
	caption?: string
	spoiler?: boolean
	width?: number
	height?: number
	duration?: number
	poster?: string
}

export declare class FrontierXError extends Error {
	status: number
	data: unknown
}

export declare const format: {
	bold(text: string): string
	italic(text: string): string
	strike(text: string): string
	code(text: string): string
	pre(text: string): string
	spoiler(text: string): string
	quote(text: string): string
}

export declare function describeContent(plaintext: string): { kind: MessageContext["kind"]; text: string; media?: Media; location?: Location; contact?: Contact }
export declare function encodeLocation(location: Location): string
export declare function buttons(rows: Button[][]): Button[][]
export declare function encodeContact(contact: Contact): string

export declare class FrontierXBot {
	constructor(options?: BotOptions)
	on(event: "text" | "media" | "location" | "contact" | "message" | "edited", handler: (ctx: MessageContext) => unknown): this
	on(event: "deleted", handler: (ctx: { bot: FrontierXBot; conversationId: string; messageId: string }) => unknown): this
	on(event: "conversation", handler: (ctx: { bot: FrontierXBot; conversationId: string; conversation: { id: string; kind: string; title: string | null }; by: Sender | null; send(text: string, options?: SendOptions): Promise<MessageEnvelope> }) => unknown): this
	on(event: "callback", handler: (ctx: CallbackContext) => unknown): this
	on(event: "update", handler: (ctx: { bot: FrontierXBot; update: Record<string, unknown> }) => unknown): this
	on(event: "error", handler: (ctx: { error: unknown; ctx?: unknown; update?: unknown }) => unknown): this
	action(pattern: string | RegExp, handler: (ctx: CallbackContext) => unknown): this
	answerCallback(conversationId: string, callbackId: string, text?: string, options?: { alert?: boolean }): Promise<unknown>
	command(name: string, handler: (ctx: MessageContext & { command: string; args: string }) => unknown): this
	init(): Promise<{ id: string; username: string; displayName: string; publicKey: string | null }>
	start(): Promise<void>
	stop(): void
	call<T = unknown>(method: "GET" | "POST", name: string, payload?: Record<string, unknown>): Promise<T>
	sendText(conversationId: string, text: string, options?: SendOptions): Promise<MessageEnvelope>
	sendLocation(conversationId: string, location: Location, options?: SendOptions): Promise<MessageEnvelope>
	sendContact(conversationId: string, contact: Contact, options?: SendOptions): Promise<MessageEnvelope>
	sendFile(conversationId: string, input: FileInput, options?: FileOptions): Promise<MessageEnvelope>
	sendPhoto(conversationId: string, input: FileInput, options?: FileOptions): Promise<MessageEnvelope>
	sendVideo(conversationId: string, input: FileInput, options?: FileOptions): Promise<MessageEnvelope>
	sendDocument(conversationId: string, input: FileInput, options?: FileOptions): Promise<MessageEnvelope>
	editText(conversationId: string, messageId: string, text: string, options?: { buttons?: Button[][] }): Promise<MessageEnvelope>
	deleteMessage(conversationId: string, messageId: string): Promise<unknown>
	sendTyping(conversationId: string): Promise<unknown>
	leave(conversationId: string): Promise<unknown>
	setCommands(commands: Array<{ command: string; description: string }>): Promise<unknown>
	getConversations(): Promise<Array<{ id: string; kind: string; title: string | null; createdAt: string }>>
	getConversation(conversationId: string): Promise<{ conversation: { id: string; kind: string; title: string | null }; members: Array<{ userId: string; role: string; username: string | null; displayName: string | null; isBot: boolean }> }>
	decrypt(conversationId: string, ciphertext: string): Promise<string | null>
	downloadMedia(media: Media): Promise<Uint8Array>
	webhookHandler(secret: string): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>
	setWebhook(url: string, secret: string): Promise<unknown>
	deleteWebhook(): Promise<unknown>
}

export default FrontierXBot
