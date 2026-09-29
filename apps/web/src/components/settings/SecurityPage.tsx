import { useEffect, useState } from "react"
import { api } from "../../lib/api"
import { fingerprint } from "../../lib/keyvault"
import type { LinkRequestInfo } from "../../lib/types"
import { errorText } from "../../lib/errorText"
import { useAuth } from "../../state/auth"
import { useSettings } from "../../state/settings"
import { formatDateTime } from "../../lib/i18n"
import { Banner, Button, ListGroup, ListItem, Sheet, SwitchItem, TextField } from "../m3"
import { ICheck, IDevices, IFingerprint, IKey, ILock, IShield, IWarning } from "../m3icons"
import { LinkApprovalSheet } from "../LinkApprovalSheet"
import { PageIntro, SecretBox } from "./common"

// Encryption keys and how to get them back: recovery key, password, other
// devices. Everything here works on the account key this device holds.
export function SecurityPage() {
	const { t, lang } = useSettings()
	const { keys, refreshKeyHealth } = useAuth()
	const [recoveryOpen, setRecoveryOpen] = useState(false)
	const [passwordOpen, setPasswordOpen] = useState(false)
	const [sealOpen, setSealOpen] = useState(false)
	const [requests, setRequests] = useState<LinkRequestInfo[]>([])
	const [approving, setApproving] = useState<LinkRequestInfo | null>(null)
	const [fp, setFp] = useState<string | null>(null)

	useEffect(() => {
		void refreshKeyHealth().catch(() => undefined)
		const load = () => void api.pendingLinks().then((res) => setRequests(res.requests)).catch(() => undefined)
		load()
		const timer = window.setInterval(load, 10000)
		return () => window.clearInterval(timer)
	}, [refreshKeyHealth])

	useEffect(() => {
		if (keys.status === "ready" && keys.session.publicKey) void fingerprint(keys.session.publicKey).then(setFp)
	}, [keys])

	if (keys.status !== "ready") {
		return <Banner tone="warning" icon={<ILock />} title={t("keysLockedTitle")}>{t("keysLockedCopy")}</Banner>
	}
	const health = keys.health
	const groups = fp ? fp.slice(0, 32).match(/.{4}/g)?.join(" ") ?? fp : null

	return (
		<div className="m3-stack">
			{health.hasRecoverySlot && health.hasPasswordSlot ? (
				<Banner tone="success" icon={<IShield />} title={t("keysHealthyTitle")}>{t("keysHealthyCopy")}</Banner>
			) : (
				<Banner tone="warning" icon={<IWarning />} title={t("keysAtRiskTitle")} actions={!health.hasRecoverySlot ? <Button variant="filled" onClick={() => setRecoveryOpen(true)}>{t("recoveryCreate")}</Button> : undefined}>
					{!health.hasPasswordSlot ? t("keysNoPasswordCopy") : t("keysNoRecoveryCopy")}
				</Banner>
			)}
			<PageIntro>{t("keysExplain")}</PageIntro>

			<ListGroup label={t("keysWaysBack")}>
				<ListItem
					title={t("recoveryKeyTitle")}
					subtitle={health.hasRecoverySlot ? t("recoveryKeySet") : t("recoveryKeyMissing")}
					icon={<IKey />}
					shape="cookie12"
					tone="violet"
					trailing={health.hasRecoverySlot ? <ICheck /> : null}
					onClick={() => setRecoveryOpen(true)}
					chevron
				/>
				{health.hasPasswordSlot ? (
					<ListItem title={t("changePassword")} subtitle={t("changePasswordHint")} icon={<ILock />} shape="circle" tone="blue" onClick={() => setPasswordOpen(true)} chevron />
				) : (
					<ListItem title={t("sealWithPasswordTitle")} subtitle={t("sealWithPasswordHint")} icon={<ILock />} shape="circle" tone="orange" onClick={() => setSealOpen(true)} chevron />
				)}
				<ListItem title={t("linkDevicesTitle")} subtitle={t("linkDevicesHint")} multiline icon={<IDevices />} shape="pentagon" tone="teal" />
			</ListGroup>

			{requests.length > 0 ? (
				<ListGroup label={t("linkPendingTitle")}>
					{requests.map((request) => (
						<ListItem key={request.id} title={request.label} subtitle={formatDateTime(lang, request.createdAt)} icon={<IDevices />} shape="clover" tone="tertiary" onClick={() => setApproving(request)} chevron />
					))}
				</ListGroup>
			) : null}

			<ListGroup label={t("keysIdentity")}>
				<ListItem title={t("keysFingerprint")} subtitle={groups ?? "…"} multiline icon={<IFingerprint />} shape="circle" tone="neutral" />
				<ListItem title={t("keysVaultCount")} subtitle={String(health.vaultCount)} icon={<IShield />} shape="circle" tone="neutral" />
			</ListGroup>

			{recoveryOpen ? <RecoveryKeySheet exists={health.hasRecoverySlot} onClose={() => setRecoveryOpen(false)} /> : null}
			{passwordOpen ? <ChangePasswordSheet onClose={() => setPasswordOpen(false)} /> : null}
			{sealOpen ? <SealPasswordSheet onClose={() => setSealOpen(false)} /> : null}
			{approving ? <LinkApprovalSheet request={approving} onClose={() => { setApproving(null); setRequests((prev) => prev.filter((item) => item.id !== approving.id)) }} /> : null}
		</div>
	)
}

function RecoveryKeySheet(props: { exists: boolean; onClose: () => void }) {
	const { t } = useSettings()
	const { createRecoveryKey } = useAuth()
	const [code, setCode] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [saved, setSaved] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const create = async () => {
		setBusy(true)
		setError(null)
		try {
			setCode(await createRecoveryKey())
		} catch (err) {
			setError(errorText(err, t("recoveryCreateFailed")))
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet title={t("recoveryKeyTitle")} icon={<IKey />} iconShape="cookie12" iconTone="violet" onClose={props.onClose} size="sm" dismissible={!code || saved}
			actions={
				code ? (
					<Button variant="filled" disabled={!saved} onClick={props.onClose}>{t("done")}</Button>
				) : (
					<>
						<Button variant="text" onClick={props.onClose}>{t("cancel")}</Button>
						<Button variant="filled" busy={busy} onClick={() => void create()}>{props.exists ? t("recoveryRegenerate") : t("recoveryCreate")}</Button>
					</>
				)
			}
		>
			{!code ? (
				<>
					<p className="settings-intro">{t("recoveryExplain")}</p>
					{props.exists ? <Banner tone="warning" icon={<IWarning />}>{t("recoveryReplaceWarning")}</Banner> : null}
				</>
			) : (
				<div className="m3-stack">
					<p className="settings-intro">{t("recoveryShowOnce")}</p>
					<SecretBox value={code} fileName="frontierx-recovery-key.txt" fileText={t("recoveryFileText") + "\n\n" + code + "\n"} />
					<SwitchItem title={t("recoverySavedConfirm")} checked={saved} onChange={setSaved} />
				</div>
			)}
			{error ? <Banner tone="error">{error}</Banner> : null}
		</Sheet>
	)
}

function ChangePasswordSheet(props: { onClose: () => void }) {
	const { t } = useSettings()
	const { changePassword } = useAuth()
	const [current, setCurrent] = useState("")
	const [next, setNext] = useState("")
	const [repeat, setRepeat] = useState("")
	const [others, setOthers] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [done, setDone] = useState(false)
	const submit = async () => {
		setError(null)
		if (next.length < 8) return setError(t("passwordTooShort"))
		if (next !== repeat) return setError(t("passwordMismatch"))
		setBusy(true)
		try {
			await changePassword(current, next, others)
			setDone(true)
		} catch (err) {
			setError(errorText(err, t("passwordChangeFailed")))
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet title={t("changePassword")} icon={<ILock />} iconShape="circle" iconTone="blue" onClose={props.onClose} size="sm"
			actions={
				done ? (
					<Button variant="filled" onClick={props.onClose}>{t("done")}</Button>
				) : (
					<>
						<Button variant="text" onClick={props.onClose}>{t("cancel")}</Button>
						<Button variant="filled" busy={busy} disabled={!current || !next} onClick={() => void submit()}>{t("changePassword")}</Button>
					</>
				)
			}
		>
			{done ? (
				<Banner tone="success" icon={<ICheck />}>{t("passwordChangedKeys")}</Banner>
			) : (
				<>
					<p className="settings-intro">{t("changePasswordCopy")}</p>
					<TextField label={t("currentPassword")} type="password" autoComplete="current-password" value={current} onChange={setCurrent} autoFocus />
					<TextField label={t("newPassword")} type="password" autoComplete="new-password" value={next} onChange={setNext} />
					<TextField label={t("repeatPassword")} type="password" autoComplete="new-password" value={repeat} onChange={setRepeat} onEnter={() => void submit()} />
					<div className="m3-list-group settings-switch-row">
						<SwitchItem title={t("signOutOthers")} checked={others} onChange={setOthers} />
					</div>
					{error ? <Banner tone="error">{error}</Banner> : null}
				</>
			)}
		</Sheet>
	)
}

function SealPasswordSheet(props: { onClose: () => void }) {
	const { t } = useSettings()
	const { sealWithPassword } = useAuth()
	const [password, setPassword] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const submit = async () => {
		setBusy(true)
		setError(null)
		try {
			await sealWithPassword(password)
			props.onClose()
		} catch (err) {
			setError(errorText(err, t("sealWithPasswordFailed")))
			setBusy(false)
		}
	}
	return (
		<Sheet title={t("sealWithPasswordTitle")} icon={<ILock />} iconShape="circle" iconTone="orange" onClose={props.onClose} size="sm"
			actions={
				<>
					<Button variant="text" onClick={props.onClose}>{t("cancel")}</Button>
					<Button variant="filled" busy={busy} disabled={!password} onClick={() => void submit()}>{t("confirm")}</Button>
				</>
			}
		>
			<p className="settings-intro">{t("sealWithPasswordCopy")}</p>
			<TextField label={t("password")} type="password" autoComplete="current-password" value={password} onChange={setPassword} onEnter={() => void submit()} autoFocus error={error} />
		</Sheet>
	)
}
