import { useState } from "react"
import { Banner, Button, Sheet } from "../m3"
import { ILogout, IWarning } from "../m3icons"
import { useAuth } from "../../state/auth"
import { useSettings } from "../../state/settings"
import { getToken } from "../../lib/session"
import { unregisterWebPushFor } from "../../lib/webpush"
import { errorText } from "../../lib/errorText"
import { SecretBox } from "./common"

// Signing out removes this account and its keys from the device. The keys stay
// safe on the server behind the password; if nothing but this device could
// open them, the person is offered a recovery key first.
export function SignOutSheet(props: { onClose: () => void }) {
	const { t } = useSettings()
	const { user, keys, logout, createRecoveryKey } = useAuth()
	const [code, setCode] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const risky = keys.status === "ready" && !keys.health.hasPasswordSlot && !keys.health.hasRecoverySlot

	const signOut = async () => {
		setBusy(true)
		const token = getToken()
		if (token) await unregisterWebPushFor(token).catch(() => undefined)
		logout()
	}

	return (
		<Sheet title={t("signOutTitle")} subtitle={user ? "@" + user.username : undefined} icon={<ILogout />} iconTone="error" iconShape="clover" onClose={props.onClose} size="sm"
			actions={
				<>
					<Button variant="text" onClick={props.onClose}>{t("cancel")}</Button>
					<Button variant="danger" busy={busy} onClick={() => void signOut()}>{t("signOut")}</Button>
				</>
			}
		>
			<p className="settings-intro">{t("signOutCopy")}</p>
			{risky && !code ? (
				<Banner tone="warning" icon={<IWarning />} title={t("signOutRiskTitle")} actions={
					<Button variant="filled" busy={busy} onClick={() => {
						setBusy(true)
						setError(null)
						void createRecoveryKey().then(setCode).catch((err) => setError(errorText(err, t("recoveryCreateFailed")))).finally(() => setBusy(false))
					}}>{t("recoveryCreate")}</Button>
				}>
					{t("signOutRiskCopy")}
				</Banner>
			) : null}
			{code ? (
				<div className="m3-stack">
					<p className="settings-intro">{t("recoveryShowOnce")}</p>
					<SecretBox value={code} fileName="frontierx-recovery-key.txt" fileText={t("recoveryFileText") + "\n\n" + code + "\n"} />
				</div>
			) : null}
			{error ? <Banner tone="error">{error}</Banner> : null}
		</Sheet>
	)
}
