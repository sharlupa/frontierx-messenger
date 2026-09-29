import { useEffect, useRef, useState } from "react"
import type { ChangeEvent } from "react"
import { api, type EmailState } from "../../lib/api"
import { errorText } from "../../lib/errorText"
import type { User } from "../../lib/types"
import { useSettings } from "../../state/settings"
import { useAuth } from "../../state/auth"
import { AvatarCropper } from "../AvatarCropper"
import { Avatar, Banner, Button, ListGroup, ListItem, Sheet, TextField } from "../m3"
import { IImage, IMail, IPerson, ITrash, IWarning } from "../m3icons"
import { CopyButton, PageIntro } from "./common"

export function AccountPage(props: { user: User; onUpdated: (user: User) => void }) {
	const { t } = useSettings()
	const { user } = props
	const [displayName, setDisplayName] = useState(user.displayName)
	const [saving, setSaving] = useState(false)
	const [avatarBusy, setAvatarBusy] = useState(false)
	const [cropperSrc, setCropperSrc] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [deleting, setDeleting] = useState(false)
	const fileRef = useRef<HTMLInputElement | null>(null)

	const saveName = async () => {
		const name = displayName.trim()
		if (!name || name === user.displayName) return
		setSaving(true)
		setError(null)
		setNotice(null)
		try {
			const res = await api.updateProfile({ displayName: name })
			props.onUpdated(res.user)
			setNotice(t("profileSaved"))
		} catch (err) {
			setError(errorText(err, t("profileSaveFailed")))
		} finally {
			setSaving(false)
		}
	}

	const onPickAvatar = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files && event.target.files[0] ? event.target.files[0] : null
		event.target.value = ""
		if (!file) return
		if (file.size > 8 * 1024 * 1024) {
			setError(t("fileTooLarge") + " 8 MB")
			return
		}
		const reader = new FileReader()
		reader.onload = () => {
			if (typeof reader.result === "string") setCropperSrc(reader.result)
		}
		reader.readAsDataURL(file)
	}

	const setAvatar = async (value: string | null) => {
		setAvatarBusy(true)
		setError(null)
		setNotice(null)
		try {
			const res = await api.setMyAvatar(value)
			props.onUpdated(res.user)
			setNotice(t("profileSaved"))
		} catch (err) {
			setError(errorText(err, value ? t("avatarSaveFailed") : t("avatarRemoveFailed")))
		} finally {
			setAvatarBusy(false)
		}
	}

	return (
		<div className="m3-stack">
			{error ? <Banner tone="error">{error}</Banner> : null}
			{notice ? <Banner tone="success">{notice}</Banner> : null}
			<section className="settings-avatar-card">
				<Avatar src={user.avatar} label={user.displayName || user.username} seed={user.id} size={88} />
				<div className="m3-row">
					<Button variant="tonal" icon={<IImage size={18} />} busy={avatarBusy} onClick={() => fileRef.current?.click()}>{t("uploadPhoto")}</Button>
					{user.avatar ? <Button variant="text" busy={avatarBusy} onClick={() => void setAvatar(null)}>{t("deleteAction")}</Button> : null}
				</div>
				<input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickAvatar} />
			</section>

			<ListGroup label={t("profile")}>
				<div className="m3-list-item settings-form-item">
					<TextField label={t("displayName")} value={displayName} maxLength={64} onChange={setDisplayName} onEnter={() => void saveName()} />
					{displayName.trim() !== user.displayName ? (
						<div className="m3-row settings-form-actions">
							<Button variant="filled" busy={saving} onClick={() => void saveName()}>{t("saveProfile")}</Button>
						</div>
					) : null}
				</div>
				<ListItem title={"@" + user.username} subtitle={t("usernameHint")} icon={<IPerson />} shape="circle" tone="secondary" trailing={<CopyButton value={"@" + user.username} label={t("copy")} />} />
			</ListGroup>

			<EmailSection />

			<ListGroup label={t("deleteAccountTitle")}>
				<ListItem title={t("deleteAccountButton")} subtitle={t("deleteAccountText")} multiline icon={<ITrash />} shape="clover" danger onClick={() => setDeleting(true)} />
			</ListGroup>

			{cropperSrc ? <AvatarCropper src={cropperSrc} onCancel={() => setCropperSrc(null)} onConfirm={(dataUrl) => { setCropperSrc(null); void setAvatar(dataUrl) }} /> : null}
			{deleting ? <DeleteAccountSheet onClose={() => setDeleting(false)} /> : null}
		</div>
	)
}

function EmailSection() {
	const { t } = useSettings()
	const [state, setState] = useState<EmailState | null>(null)
	const [email, setEmail] = useState("")
	const [code, setCode] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)

	const refresh = async () => {
		const next = await api.getEmailState().catch(() => null)
		if (next) setState(next)
	}
	useEffect(() => {
		void refresh()
	}, [])

	const run = async (action: () => Promise<void>) => {
		setBusy(true)
		setError(null)
		setNotice(null)
		try {
			await action()
			await refresh()
		} catch (err) {
			setError(errorText(err, t("emailFailed")))
		} finally {
			setBusy(false)
		}
	}

	return (
		<ListGroup label={t("emailSection")}>
			<div className="m3-list-item settings-form-item">
				<PageIntro>{t("emailCopy")}</PageIntro>
				{error ? <Banner tone="error">{error}</Banner> : null}
				{notice ? <Banner tone="success">{notice}</Banner> : null}
				{state && !state.mailerEnabled ? <Banner tone="warning" icon={<IWarning />}>{t("emailUnavailable")}</Banner> : null}
				{state && state.email ? (
					<div className="settings-email-row">
						<IMail />
						<span className="grow">{state.email}</span>
						<Button variant="text" busy={busy} onClick={() => void run(async () => { await api.removeEmail(); setNotice(t("emailDetachedNotice")) })}>{t("emailDetach")}</Button>
					</div>
				) : null}
				{state && state.mailerEnabled && !state.email ? (
					<>
						<TextField label={t("emailAddress")} type="email" inputMode="email" autoComplete="email" value={email} onChange={setEmail} />
						<div className="m3-row settings-form-actions">
							<Button variant="filled" busy={busy} disabled={!email.trim()} onClick={() => void run(async () => {
								const res = await api.startEmailAttach(email.trim())
								if (res.sent === false) setError(t("emailNotDelivered"))
								else setNotice(t("emailPendingFor") + " " + res.email)
							})}>{t("emailSendCode")}</Button>
						</div>
					</>
				) : null}
				{state && state.pending ? (
					<>
						<TextField label={t("emailCodeLabel")} inputMode="numeric" maxLength={6} value={code} onChange={setCode} supporting={state.pending.email} />
						<div className="m3-row settings-form-actions">
							<Button variant="text" busy={busy} onClick={() => void run(async () => {
								const target = state.pending ? state.pending.email : email.trim()
								const res = await api.startEmailAttach(target)
								if (res.sent === false) setError(t("emailNotDelivered"))
								else setNotice(t("emailPendingFor") + " " + target)
							})}>{t("emailResend")}</Button>
							<Button variant="filled" busy={busy} disabled={code.trim().length !== 6} onClick={() => void run(async () => {
								await api.confirmEmailAttach(code.trim())
								setCode("")
								setEmail("")
								setNotice(t("emailAttachedNotice"))
							})}>{t("emailConfirm")}</Button>
						</div>
					</>
				) : null}
			</div>
		</ListGroup>
	)
}

function DeleteAccountSheet(props: { onClose: () => void }) {
	const { t } = useSettings()
	const { user, removeAccountFromDevice } = useAuth()
	const [password, setPassword] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const confirm = async () => {
		if (!password) {
			setError(t("deleteAccountNeedPassword"))
			return
		}
		setBusy(true)
		setError(null)
		try {
			await api.deleteAccount({ password })
			// The account is gone everywhere; nothing of it stays on this device.
			if (user) removeAccountFromDevice(user.id)
			else window.location.assign("/")
		} catch (err) {
			setError(errorText(err, t("deleteAccountFailed")))
			setBusy(false)
		}
	}
	return (
		<Sheet title={t("deleteAccountTitle")} icon={<ITrash />} iconTone="error" iconShape="burst" onClose={props.onClose} size="sm" role="alertdialog"
			actions={
				<>
					<Button variant="text" onClick={props.onClose}>{t("deleteAccountCancel")}</Button>
					<Button variant="danger" busy={busy} onClick={() => void confirm()}>{t("deleteAccountConfirm")}</Button>
				</>
			}
		>
			<p className="settings-intro">{t("deleteAccountText")}</p>
			<TextField label={t("deleteAccountPassword")} type="password" autoComplete="current-password" value={password} onChange={setPassword} onEnter={() => void confirm()} autoFocus error={error} />
		</Sheet>
	)
}
