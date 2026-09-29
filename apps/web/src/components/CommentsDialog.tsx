import { useState } from "react"
import { parsePollMessage } from "../lib/poll"
import type { PollEnvelope } from "../lib/poll"
import { formatTimeOfDay, plural } from "../lib/i18n"
import { useSettings } from "../state/settings"
import { LoadingBlock } from "./Expressive"
import { renderRichText } from "../lib/richtext"
import { Button, Sheet } from "./m3"
import { IChat, ISend } from "./m3icons"

export type CommentItem = { id: string; author: string; text: string; createdAt: string; isSelf: boolean }

const SENDER_COLORS = ["#e17076", "#7bc862", "#65aadd", "#a695e7", "#ee7aae", "#6ec9cb", "#f2a45c"]
function senderColor(seed: string): string {
	let hash = 0
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
	return SENDER_COLORS[hash % SENDER_COLORS.length]
}

function PollPreview({ env, label }: { env: PollEnvelope; label: string }) {
	return (
		<div className="comment-poll">
			<div className="comment-poll-type">{label}</div>
			<div className="comment-poll-question">{env.question}</div>
			<ul className="comment-poll-options">
				{env.options.map((option, index) => (
					<li className="comment-poll-option" key={index}>{option}</li>
				))}
			</ul>
		</div>
	)
}

function CommentBody({ text }: { text: string }) {
	const { t } = useSettings()
	const poll = parsePollMessage(text)
	if (!poll) return <div className="bubble-text">{renderRichText(text)}</div>
	return <PollPreview env={poll} label={poll.quiz ? t("pollQuiz") : t("pollShort")} />
}

export function CommentsDialog({
	comments,
	loading,
	canComment,
	parent,
	onClose,
	onPost,
}: {
	comments: CommentItem[]
	loading: boolean
	canComment: boolean
	parent?: { author: string; text: string } | null
	onClose: () => void
	onPost: (text: string) => Promise<void>
}) {
	const { t, lang } = useSettings()
	const [text, setText] = useState("")
	const [busy, setBusy] = useState(false)
	async function submit() {
		const body = text.trim()
		if (!body || busy) return
		setBusy(true)
		try {
			await onPost(body)
			setText("")
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet title={t("comments")} subtitle={plural(lang, "comments", comments.length)} icon={<IChat />} iconShape="cookie" iconTone="blue" onClose={onClose} size="lg" className="comments-sheet"
			actions={canComment ? (
				<div className="comment-composer">
					<textarea className="input" rows={2} placeholder={t("writeComment")} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit() } }} />
					<Button variant="filled" icon={<ISend size={16} />} busy={busy} disabled={!text.trim()} onClick={() => void submit()}>{t("send")}</Button>
				</div>
			) : undefined}
		>
			{parent ? (
				<div className="comments-parent">
					<div className="comments-parent-label">{t("originalPost")}</div>
					<div className="comment-author">{parent.author}</div>
					<CommentBody text={parent.text} />
				</div>
			) : null}
			<div className="comments-list">
				{loading ? <LoadingBlock label={t("loadingMessages")} size={40} /> : null}
				{!loading && comments.length === 0 ? <div className="comments-empty muted">{t("noComments")}</div> : null}
				{comments.map((comment) => (
					<div className={"message-row comment-msg" + (comment.isSelf ? " mine" : "")} key={comment.id}>
						<div className={"bubble" + (comment.isSelf ? " mine" : "")}>
							{!comment.isSelf ? <div className="bubble-sender" style={{ color: senderColor(comment.author) }}>{comment.author}</div> : null}
							<CommentBody text={comment.text} />
							<div className="bubble-meta"><div>{formatTimeOfDay(lang, comment.createdAt)}</div></div>
						</div>
					</div>
				))}
			</div>
		</Sheet>
	)
}
