import { useEffect, useState } from "react"
import { api } from "../lib/api"
import { linkCode } from "../lib/keyvault"
import { approveLink } from "../lib/accountKeys"
import type { LinkRequestInfo } from "../lib/types"
import { errorText } from "../lib/errorText"
import { useAuth } from "../state/auth"
import { useSettings } from "../state/settings"
import { Banner, Button, Sheet } from "./m3"
import { IDevices, IWarning } from "./m3icons"

// A new device asks to receive the account key. The person compares the
// code shown here with the one on the new device; only then is the key sealed
// for that device's one-time key and handed over.
export function LinkApprovalSheet(props: { request: LinkRequestInfo; onClose: () => void }) {
	const { t } = useSettings()
	const { keys } = useAuth()
	const [code, setCode] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		void linkCode(props.request.ephemeralPublicKey).then(setCode)
	}, [props.request.ephemeralPublicKey])

	const approve = async () => {
		if (keys.status !== "ready") return
		setBusy(true)
		setError(null)
		try {
			await approveLink(keys.session, props.request)
			props.onClose()
		} catch (err) {
			setError(errorText(err, t("linkApproveFailed")))
			setBusy(false)
		}
	}
	const deny = async () => {
		setBusy(true)
		try {
			await api.denyLink(props.request.id)
		} catch {
			// expired already
		}
		props.onClose()
	}

	return (
		<Sheet title={t("linkApproveTitle")} subtitle={props.request.label} icon={<IDevices />} iconShape="cookie12" iconTone="violet" onClose={props.onClose} size="sm" role="alertdialog"
			actions={
				<>
					<Button variant="text" busy={busy} onClick={() => void deny()}>{t("linkDeny")}</Button>
					<Button variant="filled" busy={busy} disabled={!code || keys.status !== "ready"} onClick={() => void approve()}>{t("linkApprove")}</Button>
				</>
			}
		>
			<p className="settings-intro">{t("linkApproveCopy")}</p>
			<div className="m3-code-block link-code">{code ?? "…"}</div>
			<Banner tone="warning" icon={<IWarning />}>{t("linkApproveWarning")}</Banner>
			{error ? <Banner tone="error">{error}</Banner> : null}
		</Sheet>
	)
}
