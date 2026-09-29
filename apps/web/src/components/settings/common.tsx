import { useState } from "react"
import type { ReactNode } from "react"
import { Button, IconButton, ListGroup, ListItem, Sheet } from "../m3"
import { ICheck, ICopy, IDownload } from "../m3icons"
import { useSettings } from "../../state/settings"

// A small sheet with one choice per row, the M3 way to pick from a few options.
export function ChoiceSheet<T extends string>(props: {
	title: string
	subtitle?: string
	options: Array<{ value: T; label: string; description?: string }>
	value: T
	onPick: (value: T) => void
	onClose: () => void
	footer?: ReactNode
}) {
	return (
		<Sheet title={props.title} subtitle={props.subtitle} onClose={props.onClose} size="sm">
			<ListGroup>
				{props.options.map((option) => (
					<ListItem
						key={option.value}
						title={option.label}
						subtitle={option.description}
						multiline
						selected={option.value === props.value}
						onClick={() => {
							props.onPick(option.value)
							props.onClose()
						}}
						trailing={option.value === props.value ? <ICheck /> : null}
					/>
				))}
			</ListGroup>
			{props.footer}
		</Sheet>
	)
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		try {
			const area = document.createElement("textarea")
			area.value = text
			area.setAttribute("readonly", "")
			area.style.position = "fixed"
			area.style.opacity = "0"
			document.body.appendChild(area)
			area.select()
			const ok = document.execCommand("copy")
			area.remove()
			return ok
		} catch {
			return false
		}
	}
}

export function downloadText(name: string, text: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }))
	const link = document.createElement("a")
	link.href = url
	link.download = name
	document.body.appendChild(link)
	link.click()
	link.remove()
	window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// A secret shown once (recovery key, bot token) with copy and save buttons.
export function SecretBox(props: { value: string; fileName?: string; fileText?: string }) {
	const { t } = useSettings()
	const [copied, setCopied] = useState(false)
	return (
		<div className="secret-box">
			<div className="m3-code-block">{props.value}</div>
			<div className="m3-row secret-box-actions">
				<Button
					variant="tonal"
					icon={copied ? <ICheck size={18} /> : <ICopy size={18} />}
					onClick={() => {
						void copyText(props.value).then((ok) => {
							setCopied(ok)
							if (ok) window.setTimeout(() => setCopied(false), 1800)
						})
					}}
				>
					{copied ? t("copied") : t("copy")}
				</Button>
				{props.fileName ? (
					<Button variant="tonal" icon={<IDownload size={18} />} onClick={() => downloadText(props.fileName as string, props.fileText ?? props.value)}>
						{t("saveFile")}
					</Button>
				) : null}
			</div>
		</div>
	)
}

export function CopyButton(props: { value: string; label: string }) {
	const [copied, setCopied] = useState(false)
	return (
		<IconButton
			label={props.label}
			size="s"
			onClick={(event) => {
				event.stopPropagation()
				void copyText(props.value).then((ok) => {
					setCopied(ok)
					if (ok) window.setTimeout(() => setCopied(false), 1500)
				})
			}}
		>
			{copied ? <ICheck size={16} /> : <ICopy size={16} />}
		</IconButton>
	)
}

export function PageIntro(props: { children: ReactNode }) {
	return <p className="settings-intro">{props.children}</p>
}
