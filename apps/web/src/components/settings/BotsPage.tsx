import { useEffect, useState } from "react"
import { api } from "../../lib/api"
import type { BotCommand, BotInfo } from "../../lib/types"
import { errorText } from "../../lib/errorText"
import { formatDateTime } from "../../lib/i18n"
import { OPEN_CONVERSATION_EVENT } from "../../lib/native"
import { useSettings } from "../../state/settings"
import { LoadingBlock } from "../Expressive"
import { Avatar, Banner, Button, IconButton, ListGroup, ListItem, Sheet, SwitchItem, TextField } from "../m3"
import { IAdd, IBot, IChat, ICode, IKey, IPeople, IRefresh, ITrash, IWarning } from "../m3icons"
import { PageIntro, SecretBox } from "./common"

function quickstart(token: string): string {
	const origin = typeof window !== "undefined" ? window.location.origin : "https://frontierx.zkito.fun"
	return [
		"// Node.js 20+: curl -O " + origin + "/sdk/frontierx-bot.mjs",
		'import { FrontierXBot } from "./frontierx-bot.mjs"',
		"",
		"const bot = new FrontierXBot({",
		'  token: process.env.FRONTIERX_BOT_TOKEN, // ' + token.slice(0, 8) + "…",
		'  baseUrl: "' + origin + '",',
		'  stateFile: "./frontierx-bot-state.json", // the bot\'s own key: keep it private',
		"})",
		'bot.command("start", (ctx) => ctx.reply("Hello, " + ctx.sender.displayName + "!"))',
		'bot.on("text", (ctx) => ctx.reply("You said: " + ctx.text))',
		"bot.start()",
	].join("\n")
}

export function openConversation(conversationId: string): void {
	window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_EVENT, { detail: { conversationId } }))
}

// Bots belong to their owner. The token is shown once; the bot keeps its own
// encryption key (the SDK creates it), so chats with bots stay end-to-end.
export function BotsPage() {
	const { t } = useSettings()
	const [bots, setBots] = useState<BotInfo[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const [open, setOpen] = useState<BotInfo | null>(null)

	const load = async () => {
		try {
			setBots((await api.listBots()).bots)
		} catch (err) {
			setError(errorText(err, t("botsLoadFailed")))
		}
	}
	useEffect(() => {
		void load()
	}, [])

	return (
		<div className="m3-stack">
			<PageIntro>{t("botsIntro")}</PageIntro>
			{error ? <Banner tone="error">{error}</Banner> : null}
			{!bots ? (
				<LoadingBlock size={44} label={t("loadingOlder")} />
			) : (
				<ListGroup label={t("botsMine")}>
					{bots.map((bot) => (
						<ListItem
							key={bot.id}
							leading={<Avatar src={bot.avatar} label={bot.displayName} seed={bot.id} size={40} />}
							title={bot.displayName}
							subtitle={"@" + bot.username + (bot.hasIdentityKey ? "" : " · " + t("botNotRunning"))}
							onClick={() => setOpen(bot)}
							chevron
						/>
					))}
					<ListItem title={t("botCreate")} icon={<IAdd />} shape="circle" tone="tertiary" onClick={() => setCreating(true)} />
				</ListGroup>
			)}
			<ListGroup label={t("botsApi")}>
				<ListItem title={t("botsDocs")} subtitle={t("botsDocsHint")} multiline icon={<ICode />} shape="pill" tone="neutral" href="/sdk/README.md" chevron />
			</ListGroup>
			{creating ? <CreateBotSheet onClose={() => setCreating(false)} onCreated={(bot) => { setBots((prev) => (prev ?? []).concat([bot])) }} /> : null}
			{open ? <BotSheet bot={open} onClose={() => setOpen(null)} onChanged={(bot) => { setBots((prev) => (prev ?? []).map((item) => (item.id === bot.id ? bot : item))); setOpen(bot) }} onDeleted={(id) => { setBots((prev) => (prev ?? []).filter((item) => item.id !== id)); setOpen(null) }} /> : null}
		</div>
	)
}

function CreateBotSheet(props: { onClose: () => void; onCreated: (bot: BotInfo) => void }) {
	const { t } = useSettings()
	const [username, setUsername] = useState("")
	const [name, setName] = useState("")
	const [description, setDescription] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [token, setToken] = useState<string | null>(null)
	const valid = /^[A-Za-z0-9_]{3,32}$/.test(username) && username.toLowerCase().endsWith("bot")
	const create = async () => {
		setBusy(true)
		setError(null)
		try {
			const res = await api.createBot({ username: username.trim(), displayName: name.trim() || username.trim(), description: description.trim() || undefined })
			props.onCreated(res.bot)
			setToken(res.token)
		} catch (err) {
			setError(errorText(err, t("botCreateFailed")))
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet title={t("botCreate")} icon={<IBot />} iconShape="pill" iconTone="tertiary" onClose={props.onClose} size="md" dismissible
			actions={token ? <Button variant="filled" onClick={props.onClose}>{t("done")}</Button> : (
				<>
					<Button variant="text" onClick={props.onClose}>{t("cancel")}</Button>
					<Button variant="filled" busy={busy} disabled={!valid} onClick={() => void create()}>{t("botCreate")}</Button>
				</>
			)}
		>
			{!token ? (
				<>
					<TextField label={t("botUsername")} value={username} onChange={(value) => setUsername(value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 32))} supporting={t("botUsernameHint")} autoFocus error={username && !valid ? t("botUsernameHint") : null} />
					<TextField label={t("botName")} value={name} maxLength={64} onChange={setName} />
					<TextField label={t("botDescription")} value={description} maxLength={512} onChange={setDescription} multiline />
					{error ? <Banner tone="error">{error}</Banner> : null}
				</>
			) : (
				<div className="m3-stack">
					<Banner tone="warning" icon={<IWarning />} title={t("botTokenOnce")}>{t("botTokenOnceCopy")}</Banner>
					<SecretBox value={token} />
					<p className="settings-intro">{t("botQuickstart")}</p>
					<pre className="bot-snippet">{quickstart(token)}</pre>
				</div>
			)}
		</Sheet>
	)
}

function BotSheet(props: { bot: BotInfo; onClose: () => void; onChanged: (bot: BotInfo) => void; onDeleted: (id: string) => void }) {
	const { t, lang } = useSettings()
	const { bot } = props
	const [name, setName] = useState(bot.displayName)
	const [description, setDescription] = useState(bot.description ?? "")
	const [commands, setCommands] = useState<BotCommand[]>(bot.commands)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [token, setToken] = useState<string | null>(null)
	const [confirmDelete, setConfirmDelete] = useState(false)

	const run = async (action: () => Promise<void>) => {
		setBusy(true)
		setError(null)
		try {
			await action()
		} catch (err) {
			setError(errorText(err, t("botSaveFailed")))
		} finally {
			setBusy(false)
		}
	}
	const dirty = name.trim() !== bot.displayName || description.trim() !== (bot.description ?? "") || JSON.stringify(commands) !== JSON.stringify(bot.commands)

	return (
		<Sheet title={bot.displayName} subtitle={"@" + bot.username} icon={<IBot />} iconShape="pill" iconTone="tertiary" onClose={props.onClose} size="md"
			actions={dirty ? (
				<Button variant="filled" busy={busy} onClick={() => void run(async () => props.onChanged((await api.updateBot(bot.id, { displayName: name.trim(), description: description.trim() || null, commands: commands.filter((item) => item.command.trim()) })).bot))}>{t("save")}</Button>
			) : undefined}
		>
			{error ? <Banner tone="error">{error}</Banner> : null}
			<ListGroup>
				<ListItem title={t("botOpenChat")} icon={<IChat />} shape="circle" tone="primary" onClick={() => void run(async () => {
					const res = await api.sendFriendRequest(bot.username)
					if (res.conversation) openConversation(res.conversation.id)
				})} chevron />
				<SwitchItem title={t("botAllowGroups")} subtitle={t("botAllowGroupsHint")} icon={<IPeople />} shape="circle" tone="green" checked={bot.allowGroups} onChange={(next) => void run(async () => props.onChanged((await api.updateBot(bot.id, { allowGroups: next })).bot))} />
				<ListItem title={t("botStatus")} subtitle={(bot.hasIdentityKey ? t("botKeyReady") : t("botNotRunning")) + (bot.lastUsedAt ? " · " + t("lastActive") + " " + formatDateTime(lang, bot.lastUsedAt) : "")} icon={<IKey />} shape="circle" tone="violet" />
			</ListGroup>
			<div className="m3-list-section">
				<div className="m3-list-label">{t("profile")}</div>
				<TextField label={t("botName")} value={name} maxLength={64} onChange={setName} />
				<TextField label={t("botDescription")} value={description} maxLength={512} onChange={setDescription} multiline />
			</div>
			<div className="m3-list-section">
				<div className="m3-list-label">{t("botCommands")}</div>
				{commands.map((command, index) => (
					<div key={index} className="bot-command-row">
						<TextField label="/" value={command.command} onChange={(value) => setCommands((prev) => prev.map((item, i) => (i === index ? { ...item, command: value.replace(/[^a-z0-9_]/gi, "").toLowerCase().slice(0, 32) } : item)))} />
						<TextField label={t("botCommandDescription")} value={command.description} maxLength={120} onChange={(value) => setCommands((prev) => prev.map((item, i) => (i === index ? { ...item, description: value } : item)))} />
						<IconButton label={t("deleteAction")} onClick={() => setCommands((prev) => prev.filter((_item, i) => i !== index))}><ITrash /></IconButton>
					</div>
				))}
				{commands.length < 50 ? <Button variant="text" icon={<IAdd size={18} />} onClick={() => setCommands((prev) => prev.concat([{ command: "", description: "" }]))}>{t("botAddCommand")}</Button> : null}
			</div>
			<ListGroup label={t("botToken")}>
				<ListItem title={t("botRegenerateToken")} subtitle={t("botRegenerateHint")} multiline icon={<IRefresh />} shape="circle" tone="orange" onClick={() => void run(async () => setToken((await api.rotateBotToken(bot.id)).token))} />
				<ListItem title={t("botDelete")} icon={<ITrash />} shape="clover" danger onClick={() => setConfirmDelete(true)} />
			</ListGroup>
			{token ? (
				<div className="m3-stack">
					<Banner tone="warning" icon={<IWarning />} title={t("botTokenOnce")}>{t("botTokenOnceCopy")}</Banner>
					<SecretBox value={token} />
				</div>
			) : null}
			{confirmDelete ? (
				<Sheet title={t("botDelete")} subtitle={"@" + bot.username} icon={<ITrash />} iconTone="error" iconShape="burst" onClose={() => setConfirmDelete(false)} size="sm" role="alertdialog"
					actions={
						<>
							<Button variant="text" onClick={() => setConfirmDelete(false)}>{t("cancel")}</Button>
							<Button variant="danger" busy={busy} onClick={() => void run(async () => { await api.deleteBot(bot.id); props.onDeleted(bot.id) })}>{t("deleteAction")}</Button>
						</>
					}
				>
					<p className="settings-intro">{t("botDeleteCopy")}</p>
				</Sheet>
			) : null}
		</Sheet>
	)
}
