import { useEffect, useState } from "react"
import type { PollEnvelope } from "../lib/poll"
import type { PollSummary } from "../lib/types"
import { plural } from "../lib/i18n"
import { useSettings } from "../state/settings"
import { errorText } from "../lib/errorText"

function percent(count: number, voters: number): number {
	return voters > 0 ? Math.round((count / voters) * 100) : 0
}

export function PollCard({ poll, envelope, canClose, onVote, onClose }: { poll: PollSummary; envelope: PollEnvelope; canClose: boolean; onVote: (indexes: number[]) => Promise<void>; onClose: () => Promise<void> }) {
	const { t, lang } = useSettings()
	const [selection, setSelection] = useState<number[]>(poll.myOptionIndexes)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const closed = Boolean(poll.closedAt)
	useEffect(() => setSelection(poll.myOptionIndexes), [poll.messageId, poll.myOptionIndexes.join(",")])

	function choose(index: number) {
		if (closed || busy) return
		if (poll.multipleChoice) setSelection((previous) => previous.includes(index) ? previous.filter((value) => value !== index) : previous.concat([index]).sort((a, b) => a - b))
		else setSelection([index])
	}
	async function submit() {
		if (selection.length === 0 || closed) return
		setBusy(true); setError(null)
		try { await onVote(selection) } catch (voteError) { setError(errorText(voteError, t("pollErrorGeneric"))) } finally { setBusy(false) }
	}
	async function close() {
		setBusy(true); setError(null)
		try { await onClose() } catch (closeError) { setError(errorText(closeError, t("pollErrorGeneric"))) } finally { setBusy(false) }
	}

	return (
		<section className="poll-card" aria-label={envelope.quiz ? t("pollQuiz") : t("pollShort")}>
			<div className="poll-card-type">{envelope.quiz ? t("pollQuiz") : poll.multipleChoice ? t("pollTypeMultiple") : t("pollShort")}</div>
			<h3 className="poll-card-question">{envelope.question}</h3>
			<div className="poll-choices">{envelope.options.map((option, index) => { const selected = selection.includes(index); const count = poll.optionCounts[index] ?? 0; const isCorrect = closed && envelope.quiz && envelope.correctOptionIndex === index; return <label className={"poll-choice" + (selected ? " selected" : "") + (isCorrect ? " correct" : "")} key={index}><input type={poll.multipleChoice ? "checkbox" : "radio"} name={`poll-${poll.messageId}`} checked={selected} disabled={closed || busy} onChange={() => choose(index)} /><span className="poll-choice-copy"><span className="poll-choice-line"><span>{option}</span><span>{count} · {percent(count, poll.totalVoters)}%</span></span><span className="poll-bar"><span style={{ width: `${percent(count, poll.totalVoters)}%` }} /></span></span></label> })}</div>
			<div className="poll-footer"><span>{plural(lang, "votes", poll.totalVoters)}{closed ? " · " + t("pollClosed") : ""}</span>{!closed ? <span className="poll-actions"><button className="button ghost small" disabled={busy || selection.length === 0} onClick={() => void submit()}>{poll.myOptionIndexes.length ? t("pollUpdateVote") : t("pollVote")}</button>{canClose ? <button className="link-button" disabled={busy} onClick={() => void close()}>{t("pollClose")}</button> : null}</span> : null}</div>
			{closed && envelope.quiz && envelope.correctOptionIndex != null ? <div className="poll-reveal">{t("pollCorrectPrefix")} {envelope.options[envelope.correctOptionIndex]}</div> : null}
			{error ? <div className="poll-error" role="alert">{error}</div> : null}
		</section>
	)
}
