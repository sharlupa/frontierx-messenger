import { useEffect, useState } from "react"
import { safetyNumber } from "../lib/keyvault"
import { useSettings } from "../state/settings"
import { Banner, Sheet } from "./m3"
import { IShield, IWarning } from "./m3icons"

// Checking that nobody in between swapped the keys: both people see the same
// sixty digits on their screens when their chat really is end to end.
export function SafetySheet(props: { peerName: string; peerKey: string | null; ownKey: string | null; onClose: () => void }) {
	const { t } = useSettings()
	const [digits, setDigits] = useState<string | null>(null)
	useEffect(() => {
		if (!props.peerKey || !props.ownKey) return
		void safetyNumber(props.ownKey, props.peerKey).then(setDigits)
	}, [props.peerKey, props.ownKey])
	const rows = digits ? digits.split(" ").reduce<string[][]>((acc, group, index) => {
		if (index % 4 === 0) acc.push([])
		acc[acc.length - 1].push(group)
		return acc
	}, []) : []
	return (
		<Sheet title={t("encryptionVerify")} subtitle={props.peerName} icon={<IShield />} iconShape="cookie12" iconTone="green" onClose={props.onClose} size="sm">
			<p className="settings-intro">{t("safetyCopy")}</p>
			{digits ? (
				<div className="m3-code-block safety-digits">
					{rows.map((row, index) => <div key={index}>{row.join("  ")}</div>)}
				</div>
			) : (
				<Banner tone="warning" icon={<IWarning />}>{t("safetyUnavailable")}</Banner>
			)}
			<p className="m3-note">{t("safetyHint")}</p>
		</Sheet>
	)
}
