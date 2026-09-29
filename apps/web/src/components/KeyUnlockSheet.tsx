import { useEffect, useRef, useState } from "react"
import type { LinkAttempt, LockedInfo } from "../lib/accountKeys"
import { WrongSecretError } from "../lib/accountKeys"
import { errorText } from "../lib/errorText"
import { formatDateTime } from "../lib/i18n"
import { useAuth } from "../state/auth"
import { useSettings } from "../state/settings"
import { LoadingIndicator } from "./Expressive"
import { Banner, Button, ListGroup, ListItem, Sheet, TextField } from "./m3"
import { IDevices, IKey, ILock, IRefresh, IWarning } from "./m3icons"

type Mode = "menu" | "password" | "previous" | "recovery" | "link" | "restart"

// Shown when this device cannot open the account's keys by itself: a new
// device after a password reset, or one that never held them. Every way back
// is offered; starting over is last and explains what it costs.
export function KeyUnlockSheet(props: { info: LockedInfo; onClose: () => void }) {
	const { t, lang } = useSettings()
	const { unlockWithPassword, unlockWithRecovery, startLink, finishLink, startOver } = useAuth()
	const { info } = props
	const [mode, setMode] = useState<Mode>(() => (!info.triedPassword && (info.hasPasswordSlot || info.hasLegacyBackup) ? "password" : "menu"))
	const [secret, setSecret] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [attempt, setAttempt] = useState<LinkAttempt | null>(null)
	const signal = useRef({ cancelled: false })

	useEffect(() => () => {
		signal.current.cancelled = true
	}, [])

	const go = (next: Mode) => {
		setMode(next)
		setSecret("")
		setError(null)
	}

	const run = async (action: () => Promise<void>, wrong: string) => {
		setBusy(true)
		setError(null)
		try {
			await action()
			props.onClose()
		} catch (err) {
			setError(err instanceof WrongSecretError ? wrong : errorText(err, t("unlockFailed")))
		} finally {
			setBusy(false)
		}
	}

	useEffect(() => {
		if (mode !== "link") return
		signal.current = { cancelled: false }
		const current = signal.current
		setError(null)
		void (async () => {
			try {
				const started = await startLink()
				if (current.cancelled) return
				setAttempt(started)
				await finishLink(started, current)
				if (!current.cancelled) props.onClose()
			} catch (err) {
				if (current.cancelled) return
				const message = err instanceof Error ? err.message : ""
				setError(message === "denied" ? t("linkDenied") : message === "expired" ? t("linkExpired") : errorText(err, t("unlockFailed")))
				setAttempt(null)
			}
		})()
		return () => {
			current.cancelled = true
		}
	}, [mode])

	const menu = (
		<>
			<p className="settings-intro">{info.triedPassword && info.passwordChangedAt ? t("unlockAfterReset") + " " + formatDateTime(lang, info.passwordChangedAt) + "." : t("unlockIntro")}</p>
			<ListGroup>
				{info.hasPasswordSlot || info.hasLegacyBackup ? <ListItem title={t("unlockPassword")} subtitle={t("unlockPasswordHint")} icon={<ILock />} shape="circle" tone="blue" onClick={() => go("password")} chevron /> : null}
				{info.hasStalePasswordSlot || info.hasLegacyBackup ? <ListItem title={t("unlockPrevious")} subtitle={t("unlockPreviousHint")} multiline icon={<IRefresh />} shape="circle" tone="orange" onClick={() => go("previous")} chevron /> : null}
				{info.hasRecoverySlot ? <ListItem title={t("unlockRecovery")} subtitle={t("unlockRecoveryHint")} icon={<IKey />} shape="cookie12" tone="violet" onClick={() => go("recovery")} chevron /> : null}
				<ListItem title={t("unlockLink")} subtitle={t("unlockLinkHint")} multiline icon={<IDevices />} shape="pentagon" tone="teal" onClick={() => go("link")} chevron />
			</ListGroup>
			<ListGroup>
				<ListItem title={t("unlockRestart")} subtitle={t("unlockRestartHint")} multiline icon={<IWarning />} shape="burst" danger onClick={() => go("restart")} />
			</ListGroup>
		</>
	)

	const back = mode !== "menu" ? () => { signal.current.cancelled = true; setAttempt(null); go("menu") } : undefined

	let body = menu
	let actions = null
	if (mode === "password" || mode === "previous") {
		const previous = mode === "previous"
		body = (
			<>
				<p className="settings-intro">{previous ? t("unlockPreviousCopy") : t("unlockPasswordCopy")}</p>
				<TextField label={previous ? t("previousPassword") : t("password")} type="password" autoComplete={previous ? "off" : "current-password"} value={secret} onChange={setSecret} autoFocus onEnter={() => void run(() => unlockWithPassword(secret, previous), t("unlockWrongPassword"))} error={error} />
			</>
		)
		actions = <Button variant="filled" busy={busy} disabled={!secret} onClick={() => void run(() => unlockWithPassword(secret, previous), t("unlockWrongPassword"))}>{t("unlock")}</Button>
	} else if (mode === "recovery") {
		body = (
			<>
				<p className="settings-intro">{t("unlockRecoveryCopy")}</p>
				<TextField label={t("recoveryKeyTitle")} value={secret} onChange={(value) => setSecret(value.toUpperCase())} autoFocus spellCheck={false} className="recovery-field" onEnter={() => void run(() => unlockWithRecovery(secret), t("unlockWrongRecovery"))} error={error} />
			</>
		)
		actions = <Button variant="filled" busy={busy} disabled={secret.replace(/[\s-]/g, "").length < 36} onClick={() => void run(() => unlockWithRecovery(secret), t("unlockWrongRecovery"))}>{t("unlock")}</Button>
	} else if (mode === "link") {
		body = (
			<div className="m3-stack link-wait">
				<p className="settings-intro">{t("unlockLinkCopy")}</p>
				{attempt ? <div className="m3-code-block link-code">{attempt.code}</div> : <LoadingIndicator size={48} />}
				{attempt ? (
					<div className="link-wait-row">
						<LoadingIndicator size={28} />
						<span>{t("unlockLinkWaiting")}</span>
					</div>
				) : null}
				{error ? <Banner tone="error">{error}</Banner> : null}
			</div>
		)
		actions = error ? <Button variant="tonal" onClick={() => { setMode("menu"); window.setTimeout(() => go("link"), 0) }}>{t("tryAgain")}</Button> : null
	} else if (mode === "restart") {
		body = (
			<>
				<Banner tone="warning" icon={<IWarning />} title={t("restartTitle")}>{t("restartCopy")}</Banner>
				<TextField label={t("password")} type="password" autoComplete="current-password" value={secret} onChange={setSecret} autoFocus error={error} />
			</>
		)
		actions = <Button variant="danger" busy={busy} disabled={!secret} onClick={() => void run(() => startOver(secret), t("unlockWrongPassword"))}>{t("restartConfirm")}</Button>
	}

	return (
		<Sheet
			title={t("unlockTitle")}
			subtitle={mode === "menu" ? undefined : t("unlockSubtitle")}
			icon={<ILock />}
			iconShape="cookie"
			iconTone="violet"
			onClose={props.onClose}
			onBack={back}
			size="md"
			actions={mode === "menu" ? null : actions}
		>
			{body}
			{mode === "menu" && error ? <Banner tone="error">{error}</Banner> : null}
		</Sheet>
	)
}
