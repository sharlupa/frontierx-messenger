import { useState } from "react"
import type { PollEnvelope } from "../lib/poll"
import { useSettings } from "../state/settings"
import { errorText } from "../lib/errorText"
import { Banner, Button, Chip, IconButton, ListGroup, Sheet, SwitchItem, TextField } from "./m3"
import { IAdd, ICheck, IPoll, ITrash } from "./m3icons"

export type PollDraftInput = Omit<PollEnvelope, "version">

// Creating a poll or a quiz. The question and options are sealed into the
// message like everything else; the server only counts opaque option numbers.
export function PollDialog({ onClose, onCreate }: { opener?: HTMLElement | null; onClose: () => void; onCreate: (input: PollDraftInput) => Promise<void> }) {
	const { t } = useSettings()
	const [question, setQuestion] = useState("")
	const [options, setOptions] = useState(["", ""])
	const [multipleChoice, setMultipleChoice] = useState(false)
	const [quiz, setQuiz] = useState(false)
	const [correctOptionIndex, setCorrectOptionIndex] = useState<number | null>(0)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	function updateOption(index: number, value: string) {
		setOptions((previous) => previous.map((option, optionIndex) => (optionIndex === index ? value : option)))
	}
	function removeOption(index: number) {
		if (options.length <= 2) return
		setOptions((previous) => previous.filter((_, optionIndex) => optionIndex !== index))
		setCorrectOptionIndex((previous) => (previous == null ? null : previous === index ? 0 : previous > index ? previous - 1 : previous))
	}
	async function submit() {
		const normalized = options.map((option) => option.trim())
		if (!question.trim() || normalized.some((option) => !option)) {
			setError(t("pollErrorFields"))
			return
		}
		if (quiz && correctOptionIndex == null) {
			setError(t("pollErrorCorrect"))
			return
		}
		setBusy(true)
		setError(null)
		try {
			await onCreate({ question, options: normalized, multipleChoice, quiz, correctOptionIndex: quiz ? correctOptionIndex : null })
			onClose()
		} catch (creationError) {
			setError(errorText(creationError, t("pollErrorGeneric")))
		} finally {
			setBusy(false)
		}
	}

	return (
		<Sheet title={t("pollCreateTitle")} icon={<IPoll />} iconShape="sunny" iconTone="orange" onClose={() => { if (!busy) onClose() }} size="md"
			actions={
				<>
					<Button variant="text" disabled={busy} onClick={onClose}>{t("cancel")}</Button>
					<Button variant="filled" busy={busy} onClick={() => void submit()}>{busy ? t("creating") : t("pollCreateTitle")}</Button>
				</>
			}
		>
			{error ? <Banner tone="error">{error}</Banner> : null}
			<TextField label={t("pollQuestionLabel")} maxLength={240} value={question} onChange={setQuestion} autoFocus />
			<div className="poll-option-fields">
				{options.map((option, index) => (
					<div className="poll-option-field" key={index}>
						<TextField label={t("pollOption") + " " + String(index + 1)} maxLength={128} value={option} onChange={(value) => updateOption(index, value)}
							trailing={
								<span className="m3-row">
									{quiz ? (
										<IconButton label={t("pollCorrectAnswer")} size="s" selected={correctOptionIndex === index} onClick={() => setCorrectOptionIndex(index)}><ICheck size={16} /></IconButton>
									) : null}
									{options.length > 2 ? <IconButton label={t("pollRemoveOption")} size="s" onClick={() => removeOption(index)}><ITrash size={16} /></IconButton> : null}
								</span>
							}
						/>
					</div>
				))}
			</div>
			{options.length < 10 ? (
				<div className="m3-row poll-add">
					<Chip icon={<IAdd size={16} />} onClick={() => setOptions((previous) => previous.concat([""]))}>{t("pollAddOption")}</Chip>
				</div>
			) : null}
			<ListGroup>
				<SwitchItem title={t("pollMultiple")} checked={multipleChoice} disabled={quiz} onChange={setMultipleChoice} />
				<SwitchItem title={t("pollQuiz")} subtitle={quiz ? t("pollCorrectAnswer") : undefined} checked={quiz} onChange={(enabled) => { setQuiz(enabled); if (enabled) setMultipleChoice(false) }} />
			</ListGroup>
		</Sheet>
	)
}
