import { useRef, useState } from "react"
import type { ChangeEvent } from "react"
import { api } from "../../lib/api"
import { collectDiagnostics } from "../../lib/diagnostics"
import { errorText } from "../../lib/errorText"
import { shrinkPreviewImage } from "../../lib/linkmsg"
import { useSettings } from "../../state/settings"
import { format } from "../../lib/i18n"
import { Banner, Button, IconButton, ListGroup, ListItem, SwitchItem, TextField } from "../m3"
import { IAdd, ICheck, IClose, ICode, IEye, IEyeOff, IImage, ISend } from "../m3icons"
import { PageIntro } from "./common"

// Same limits as the server (apps/api/src/bugreports.ts).
const TEXT_MIN = 3
const TEXT_MAX = 3000
// Up to five screenshots, each scaled down and compressed before it is sent.
const SCREENSHOTS_MAX = 5
const SCREENSHOT_EDGE = 1600
const SCREENSHOT_QUALITY = 0.85

export function BugReportPage() {
	const { t, lang } = useSettings()
	const [text, setText] = useState("")
	const [screenshots, setScreenshots] = useState<string[]>([])
	const [withDetails, setWithDetails] = useState(true)
	const [showDetails, setShowDetails] = useState(false)
	const [sending, setSending] = useState(false)
	const [sent, setSent] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const fileRef = useRef<HTMLInputElement | null>(null)
	const details = collectDiagnostics(lang)

	// Several pictures can be picked at once; those over the limit are left out.
	async function pickScreenshots(event: ChangeEvent<HTMLInputElement>) {
		const files = Array.from(event.target.files ?? [])
		event.target.value = ""
		if (files.length === 0) return
		setError(null)
		const room = SCREENSHOTS_MAX - screenshots.length
		const added: string[] = []
		let failed = false
		for (const file of files.slice(0, Math.max(0, room))) {
			const image = await shrinkPreviewImage(file, SCREENSHOT_EDGE, SCREENSHOT_QUALITY)
			if (image) added.push(image)
			else failed = true
		}
		setScreenshots((current) => current.concat(added).slice(0, SCREENSHOTS_MAX))
		if (files.length > room) setError(format(t("bugReportTooMany"), { max: SCREENSHOTS_MAX }))
		else if (failed) setError(t("bugReportImageFailed"))
	}

	async function send() {
		if (sending || text.trim().length < TEXT_MIN) return
		setSending(true)
		setError(null)
		try {
			await api.sendBugReport({ text: text.trim(), screenshots, diagnostics: withDetails ? collectDiagnostics(lang) : null })
			setSent(true)
			setText("")
			setScreenshots([])
			setShowDetails(false)
		} catch (err) {
			setError(errorText(err, t("bugReportFailed")))
		} finally {
			setSending(false)
		}
	}

	return (
		<div className="m3-stack">
			<PageIntro>{t("bugReportIntro")}</PageIntro>
			{sent ? (
				<Banner tone="success" icon={<ICheck />} title={t("bugReportSentTitle")}>
					{t("bugReportSentBody")}
				</Banner>
			) : null}
			{error ? <Banner tone="error">{error}</Banner> : null}
			<ListGroup label={t("bugReportWhat")}>
				<div className="m3-list-item settings-form-item">
					<TextField
						label={t("bugReportTextLabel")}
						value={text}
						multiline
						maxLength={TEXT_MAX}
						onChange={(value) => { setText(value); setSent(false) }}
						supporting={<span className="field-counter"><span>{t("bugReportTextHint")}</span><span>{text.length}/{TEXT_MAX}</span></span>}
					/>
				</div>
			</ListGroup>
			<ListGroup label={t("bugReportScreenshot")}>
				{screenshots.length > 0 ? (
					<div className="m3-list-item bug-shots">
						{screenshots.map((image, index) => (
							<figure key={index} className="bug-shot">
								<img src={image} alt={t("bugReportScreenshot") + " " + String(index + 1)} />
								<IconButton label={t("bugReportRemoveShot")} size="s" variant="tonal" className="bug-shot-remove" onClick={() => setScreenshots((current) => current.filter((_item, at) => at !== index))}>
									<IClose size={16} />
								</IconButton>
							</figure>
						))}
						{screenshots.length < SCREENSHOTS_MAX ? (
							<button type="button" className="bug-shot-add" onClick={() => fileRef.current?.click()} aria-label={t("bugReportAddMore")} title={t("bugReportAddMore")}>
								<IAdd size={24} />
								<span>{screenshots.length}/{SCREENSHOTS_MAX}</span>
							</button>
						) : null}
					</div>
				) : (
					<ListItem title={t("bugReportAttach")} subtitle={format(t("bugReportAttachHint"), { max: SCREENSHOTS_MAX })} multiline icon={<IImage />} shape="circle" tone="blue" onClick={() => fileRef.current?.click()} />
				)}
				<input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(event) => void pickScreenshots(event)} />
			</ListGroup>
			<ListGroup>
				<SwitchItem title={t("bugReportDetails")} subtitle={t("bugReportDetailsHint")} multiline icon={<ICode />} shape="circle" tone="neutral" checked={withDetails} onChange={setWithDetails} />
				{withDetails ? (
					<ListItem title={showDetails ? t("bugReportHideDetails") : t("bugReportShowDetails")} icon={showDetails ? <IEyeOff /> : <IEye />} shape="circle" tone="neutral" onClick={() => setShowDetails((value) => !value)} />
				) : null}
				{withDetails && showDetails ? <pre className="m3-list-item bug-details">{JSON.stringify(details, null, 2)}</pre> : null}
			</ListGroup>
			<div className="m3-row settings-form-actions">
				<Button variant="filled" icon={<ISend size={18} />} busy={sending} disabled={text.trim().length < TEXT_MIN} onClick={() => void send()}>{t("bugReportSend")}</Button>
			</div>
			<p className="settings-intro bug-privacy">{t("bugReportPrivacy")}</p>
		</div>
	)
}
