import { useMemo, useState } from "react"
import { formatDateTime } from "../lib/i18n"
import { useSettings } from "../state/settings"
import { Banner, Button, Chip, Sheet, SwitchItem, TextField } from "./m3"
import { ISchedule } from "./m3icons"

function pad(value: number): string {
	return String(value).padStart(2, "0")
}

function localDate(date: Date): string {
	return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
}

function localTime(date: Date): string {
	return pad(date.getHours()) + ":" + pad(date.getMinutes())
}

// Picking when a message goes out. Quick choices for the usual cases, the
// device's own date and time pickers for anything else.
export function ScheduleSheet(props: { onClose: () => void; onPick: (sendAt: string, silent: boolean) => void; initial?: string; silent?: boolean; title?: string }) {
	const { t, lang } = useSettings()
	const start = props.initial ? new Date(props.initial) : new Date(Date.now() + 3600000)
	const [date, setDate] = useState(localDate(start))
	const [time, setTime] = useState(localTime(start))
	const [silent, setSilent] = useState(Boolean(props.silent))
	const quick = useMemo(() => {
		const now = new Date()
		const inHour = new Date(now.getTime() + 3600000)
		const tonight = new Date(now)
		tonight.setHours(20, 0, 0, 0)
		const tomorrow = new Date(now)
		tomorrow.setDate(now.getDate() + 1)
		tomorrow.setHours(9, 0, 0, 0)
		const options = [{ key: "hour", label: t("scheduleInHour"), at: inHour }]
		if (tonight.getTime() - now.getTime() > 30 * 60000) options.push({ key: "tonight", label: t("scheduleTonight"), at: tonight })
		options.push({ key: "tomorrow", label: t("scheduleTomorrow"), at: tomorrow })
		return options
	}, [t])
	const chosen = new Date(date + "T" + time)
	const valid = !Number.isNaN(chosen.getTime()) && chosen.getTime() > Date.now() + 30000 && chosen.getTime() < Date.now() + 365 * 86400000
	const apply = (at: Date) => {
		setDate(localDate(at))
		setTime(localTime(at))
	}
	return (
		<Sheet title={props.title ?? t("scheduleTitle")} icon={<ISchedule />} iconShape="sunny" iconTone="orange" onClose={props.onClose} size="sm"
			actions={
				<>
					<Button variant="text" onClick={props.onClose}>{t("cancel")}</Button>
					<Button variant="filled" disabled={!valid} onClick={() => { props.onPick(chosen.toISOString(), silent); props.onClose() }}>{t("scheduleConfirm")}</Button>
				</>
			}
		>
			<div className="m3-chip-row schedule-quick">
				{quick.map((option) => (
					<Chip key={option.key} selected={localDate(option.at) === date && localTime(option.at) === time} onClick={() => apply(option.at)}>
						{option.label}
					</Chip>
				))}
			</div>
			<div className="schedule-fields">
				<TextField label={t("scheduleDate")} type="date" value={date} onChange={setDate} />
				<TextField label={t("scheduleTime")} type="time" value={time} onChange={setTime} />
			</div>
			{valid ? <p className="settings-intro schedule-summary">{t("scheduleWillSend")} {formatDateTime(lang, chosen.toISOString())}</p> : <Banner tone="warning">{t("schedulePickFuture")}</Banner>}
			<div className="m3-list-group settings-switch-row">
				<SwitchItem title={t("sendSilently")} subtitle={t("sendSilentlyHint")} checked={silent} onChange={setSilent} />
			</div>
		</Sheet>
	)
}
