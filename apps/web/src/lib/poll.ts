export type PollEnvelope = {
	version: 1
	question: string
	options: string[]
	multipleChoice: boolean
	quiz: boolean
	correctOptionIndex: number | null
}

const PREFIX = "frontierx:poll:v1:"

function normalize(input: Omit<PollEnvelope, "version">): PollEnvelope {
	const question = input.question.trim()
	const options = input.options.map((option) => option.trim())
	if (!question || question.length > 240) throw new Error("Poll question must contain 1-240 characters")
	if (options.length < 2 || options.length > 10 || options.some((option) => !option || option.length > 128)) {
		throw new Error("A poll needs 2-10 options of up to 128 characters")
	}
	if (input.quiz && input.multipleChoice) throw new Error("A quiz accepts one answer")
	const correctOptionIndex = input.quiz ? input.correctOptionIndex : null
	if (input.quiz && (!Number.isInteger(correctOptionIndex) || (correctOptionIndex as number) < 0 || (correctOptionIndex as number) >= options.length)) {
		throw new Error("Choose the correct quiz answer")
	}
	return { version: 1, question, options, multipleChoice: Boolean(input.multipleChoice), quiz: Boolean(input.quiz), correctOptionIndex }
}

export function encodePollMessage(input: Omit<PollEnvelope, "version">): string {
	return PREFIX + JSON.stringify(normalize(input))
}

export function parsePollMessage(text: string | null): PollEnvelope | null {
	if (!text || !text.startsWith(PREFIX)) return null
	try {
		const value = JSON.parse(text.slice(PREFIX.length)) as Partial<PollEnvelope>
		if (value.version !== 1 || typeof value.question !== "string" || !Array.isArray(value.options)) return null
		return normalize({
			question: value.question,
			options: value.options.map((option) => String(option)),
			multipleChoice: value.multipleChoice === true,
			quiz: value.quiz === true,
			correctOptionIndex: value.correctOptionIndex == null ? null : Number(value.correctOptionIndex),
		})
	} catch {
		return null
	}
}
