import { useEffect, useState } from "react"
import { api } from "../../lib/api"
import type { Friend, PrivacyException, PrivacyMode, PrivacyPolicy, PrivacyScope } from "../../lib/types"
import { useSettings } from "../../state/settings"
import { LoadingBlock } from "../Expressive"
import { Avatar, Banner, Chip, ListGroup, ListItem, Sheet, SwitchItem, TextField } from "../m3"
import { IClock, IEyeOff, IGlobe, IPeople, IPhone, IShield } from "../m3icons"
import { ChoiceSheet, PageIntro } from "./common"
import type { StringKey } from "../../lib/i18n"

type Settings = {
	requireInvite: boolean
	ghostMode: boolean
	lastSeenPolicy: PrivacyPolicy
	seenTimePolicy: PrivacyPolicy
	callsPolicy: PrivacyPolicy
	exceptions: PrivacyException[]
}

const POLICY_LABEL: Record<PrivacyPolicy, StringKey> = { everyone: "policyEveryone", contacts: "policyContacts", nobody: "policyNobody" }

// Who sees you and who can reach you. Each rule is a row; its choice opens as
// a small sheet, and exceptions per contact override it in either direction.
export function PrivacyPage() {
	const { t } = useSettings()
	const [settings, setSettings] = useState<Settings | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [picking, setPicking] = useState<PrivacyScope | null>(null)
	const [exceptionsFor, setExceptionsFor] = useState<PrivacyScope | null>(null)

	useEffect(() => {
		let active = true
		void api.getSettings().then((res) => { if (active) setSettings(res) }).catch(() => { if (active) setError(t("settingsLoadFailed")) })
		return () => { active = false }
	}, [t])

	const save = async (patch: Parameters<typeof api.setSettings>[0]) => {
		setError(null)
		try {
			setSettings(await api.setSettings(patch))
		} catch {
			setError(t("settingsSaveFailed"))
		}
	}

	if (!settings) return error ? <Banner tone="error">{error}</Banner> : <LoadingBlock size={44} label={t("loadingOlder")} />

	const policyOf = (scope: PrivacyScope): PrivacyPolicy => (scope === "calls" ? settings.callsPolicy : scope === "seenTime" ? settings.seenTimePolicy : settings.lastSeenPolicy)
	const count = (scope: PrivacyScope) => settings.exceptions.filter((item) => item.scope === scope).length
	const subtitle = (scope: PrivacyScope) => t(POLICY_LABEL[policyOf(scope)]) + (count(scope) > 0 ? " · " + t("exceptionsCount") + " " + String(count(scope)) : "")
	const titles: Record<PrivacyScope, StringKey> = { lastSeen: "lastSeenLabel", seenTime: "seenTimeLabel", calls: "callsLabel" }
	const copies: Record<PrivacyScope, StringKey> = { lastSeen: "lastSeenCopy", seenTime: "seenTimeCopy", calls: "callsCopy" }

	return (
		<div className="m3-stack">
			<PageIntro>{t("privacySectionCopy")}</PageIntro>
			{error ? <Banner tone="error">{error}</Banner> : null}
			<ListGroup label={t("privacyVisibility")}>
				<ListItem title={t("lastSeenLabel")} subtitle={subtitle("lastSeen")} icon={<IGlobe />} shape="circle" tone="green" onClick={() => setPicking("lastSeen")} chevron />
				<ListItem title={t("seenTimeLabel")} subtitle={subtitle("seenTime")} icon={<IClock />} shape="circle" tone="teal" onClick={() => setPicking("seenTime")} chevron />
				<SwitchItem title={t("ghostMode")} subtitle={t("ghostModeCopy")} icon={<IEyeOff />} shape="circle" tone="violet" checked={settings.ghostMode} onChange={(next) => void save({ ghostMode: next })} />
			</ListGroup>
			<ListGroup label={t("privacyReach")}>
				<ListItem title={t("callsLabel")} subtitle={subtitle("calls")} icon={<IPhone />} shape="circle" tone="blue" onClick={() => setPicking("calls")} chevron />
				<SwitchItem title={t("requireInviteLabel")} subtitle={t("requireInviteCopy")} icon={<IPeople />} shape="circle" tone="orange" checked={settings.requireInvite} onChange={(next) => void save({ requireInvite: next })} />
			</ListGroup>
			<ListGroup>
				<ListItem title={t("policyLink")} icon={<IShield />} shape="circle" tone="neutral" href="/privacy" chevron />
			</ListGroup>

			{picking ? (
				<ChoiceSheet
					title={t(titles[picking])}
					subtitle={t(copies[picking])}
					value={policyOf(picking)}
					options={(["everyone", "contacts", "nobody"] as PrivacyPolicy[]).map((value) => ({ value, label: t(POLICY_LABEL[value]) }))}
					onPick={(value) => void save(picking === "calls" ? { callsPolicy: value } : picking === "seenTime" ? { seenTimePolicy: value } : { lastSeenPolicy: value })}
					onClose={() => setPicking(null)}
					footer={
						<div className="choice-sheet-footer">
							<button type="button" className="m3-btn tonal" onClick={() => { const scope = picking; setPicking(null); setExceptionsFor(scope) }}>
								{t("exceptionsOpen")}{count(picking) > 0 ? " · " + String(count(picking)) : ""}
							</button>
						</div>
					}
				/>
			) : null}
			{exceptionsFor ? (
				<ExceptionsSheet scope={exceptionsFor} exceptions={settings.exceptions} onClose={() => setExceptionsFor(null)} onChanged={(exceptions) => setSettings({ ...settings, exceptions })} />
			) : null}
		</div>
	)
}

function ExceptionsSheet(props: { scope: PrivacyScope; exceptions: PrivacyException[]; onClose: () => void; onChanged: (next: PrivacyException[]) => void }) {
	const { t } = useSettings()
	const [friends, setFriends] = useState<Friend[] | null>(null)
	const [busyId, setBusyId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [query, setQuery] = useState("")
	useEffect(() => {
		let active = true
		void api.listFriends().then((res) => { if (active) setFriends(res.friends) }).catch(() => { if (active) setError(t("exceptionsFailed")) })
		return () => { active = false }
	}, [t])
	const modeFor = (userId: string): PrivacyMode | null => props.exceptions.find((item) => item.scope === props.scope && item.targetId === userId)?.mode ?? null
	const choose = async (userId: string, mode: PrivacyMode | null) => {
		setBusyId(userId)
		setError(null)
		try {
			props.onChanged((await api.setPrivacyException(userId, props.scope, mode)).exceptions)
		} catch {
			setError(t("exceptionsFailed"))
		} finally {
			setBusyId(null)
		}
	}
	const term = query.trim().toLocaleLowerCase()
	const list = (friends ?? []).filter((friend) => !term || (friend.displayName || friend.username).toLocaleLowerCase().includes(term) || friend.username.toLocaleLowerCase().includes(term))
	const title = t(props.scope === "calls" ? "exceptionsCalls" : props.scope === "seenTime" ? "exceptionsSeenTime" : "exceptionsLastSeen")
	return (
		<Sheet title={title} subtitle={t("exceptionsCopy")} onClose={props.onClose} size="md">
			<TextField label={t("searchChats")} type="search" value={query} onChange={setQuery} />
			{error ? <Banner tone="error">{error}</Banner> : null}
			{!friends ? (
				<LoadingBlock size={40} label={t("loadingOlder")} />
			) : list.length === 0 ? (
				<p className="settings-intro">{t("exceptionsEmpty")}</p>
			) : (
				<ListGroup>
					{list.map((friend) => {
						const mode = modeFor(friend.id)
						return (
							<ListItem
								key={friend.id}
								leading={<Avatar src={friend.avatar} label={friend.displayName || friend.username} seed={friend.id} size={40} />}
								title={friend.displayName || friend.username}
								subtitle={"@" + friend.username}
								className={busyId === friend.id ? "busy" : undefined}
								trailing={
									<span className="m3-chip-row exceptions-chips">
										<Chip selected={mode === "allow"} onClick={() => void choose(friend.id, mode === "allow" ? null : "allow")}>{t("exceptionAllow")}</Chip>
										<Chip selected={mode === "deny"} onClick={() => void choose(friend.id, mode === "deny" ? null : "deny")}>{t("exceptionDeny")}</Chip>
									</span>
								}
							/>
						)
					})}
				</ListGroup>
			)}
		</Sheet>
	)
}
