import { useSettings } from "../state/settings"
import { IBot } from "./m3icons"

// The mark next to a bot's name, wherever people are listed.
export function BotBadge({ size = 11 }: { size?: number }) {
	const { t } = useSettings()
	return <span className="bot-badge"><IBot size={size} /> {t("botBadge")}</span>
}
