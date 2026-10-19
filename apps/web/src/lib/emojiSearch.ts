import { EMOJI_DATA } from "./emojiData"

// Every word of the query has to match; emoji whose name starts with the
// first word come first.
export function searchEmoji(query: string, names: Record<string, string>): string[] {
	const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
	if (words.length === 0) return []
	const leading: string[] = []
	const rest: string[] = []
	for (const group of EMOJI_DATA) {
		for (const emoji of group.emoji) {
			const haystack = names[emoji]
			if (!haystack || !words.every((word) => haystack.includes(word))) continue
			if (haystack.split("|").some((name) => name.startsWith(words[0]))) leading.push(emoji)
			else rest.push(emoji)
		}
	}
	return leading.concat(rest)
}
