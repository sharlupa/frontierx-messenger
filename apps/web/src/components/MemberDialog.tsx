import { useEffect, useRef, useState } from "react"
import type { ChangeEvent } from "react"
import type { Conversation, ConversationMember, Friend, MemberRole } from "../lib/types"
import { api } from "../lib/api"
import { useSettings } from "../state/settings"
import { AvatarCropper } from "./AvatarCropper"
import { QrDialog } from "./QrDialog"
import { errorText } from "../lib/errorText"
import { formatDateTime, formatLastSeen, type StringKey } from "../lib/i18n"
import { Avatar, Banner, Button, ListGroup, ListItem, Sheet, TextField } from "./m3"
import { IAdd, IBot, IClock, ILink, ILogout, IPeople, IQr, ITrash } from "./m3icons"
import { ChoiceSheet } from "./settings/common"

const editableRoles: MemberRole[] = ["admin", "member", "restricted"]
const MAX_AVATAR_BYTES = 2 * 1024 * 1024
// 0 means the link never expires.
const INVITE_TTL_OPTIONS: ReadonlyArray<{ seconds: number; label: StringKey }> = [
	{ seconds: 3600, label: "inviteTtlHour" },
	{ seconds: 86400, label: "inviteTtlDay" },
	{ seconds: 604800, label: "inviteTtlWeek" },
	{ seconds: 2592000, label: "inviteTtlMonth" },
	{ seconds: 0, label: "inviteTtlNever" },
]

export function MemberDialog({
	members,
	onlineUserIds,
	lastSeen,
	currentUserId,
	canManage,
	conversation,
	onClose,
	onRoleChange,
	onSaveProfile,
	onLeave,
	onDelete,
	onMembersChanged,
}: {
	members: ConversationMember[]
	onlineUserIds: string[]
	lastSeen?: Record<string, string>
	currentUserId: string
	canManage: boolean
	conversation?: Conversation
	onClose: () => void
	onRoleChange: (memberId: string, role: MemberRole) => Promise<void>
	onSaveProfile?: (input: { title?: string; avatar?: string | null }) => Promise<void>
	onLeave?: () => Promise<void> | void
	onDelete?: () => Promise<void> | void
	onMembersChanged?: () => void
}) {
	const { t, lang } = useSettings()
	const [busyId, setBusyId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [name, setName] = useState(conversation?.title ?? "")
	const [avatar, setAvatar] = useState<string | null>(conversation?.avatar ?? null)
	const [cropperSrc, setCropperSrc] = useState<string | null>(null)
	const [savingProfile, setSavingProfile] = useState(false)
	const [friends, setFriends] = useState<Friend[]>([])
	const [addQuery, setAddQuery] = useState("")
	const [addBusy, setAddBusy] = useState(false)
	const [inviteLink, setInviteLink] = useState<string | null>(null)
	const [inviteExpiresAt, setInviteExpiresAt] = useState<string | null>(null)
	const [inviteTtl, setInviteTtl] = useState<number>(0)
	const [inviteCopied, setInviteCopied] = useState(false)
	const [qrLink, setQrLink] = useState<string | null>(null)
	const [leaving, setLeaving] = useState(false)
	const [confirmKind, setConfirmKind] = useState<null | "leave" | "delete">(null)
	const [ttlOpen, setTtlOpen] = useState(false)
	const [roleFor, setRoleFor] = useState<ConversationMember | null>(null)
	const fileRef = useRef<HTMLInputElement | null>(null)
	const isGroupLike = Boolean(conversation && conversation.kind !== "direct" && !conversation.isSelf)
	const canEditProfile = Boolean(canManage && onSaveProfile && isGroupLike)
	const isCreator = Boolean(conversation && conversation.createdBy === currentUserId)

	useEffect(() => {
		if (!isGroupLike) return
		let active = true
		void api.listFriends().then((res) => { if (active) setFriends(res.friends) }).catch(() => {})
		return () => { active = false }
	}, [isGroupLike])

	function onPickAvatar(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files && event.target.files[0] ? event.target.files[0] : null
		event.target.value = ""
		if (!file) return
		if (file.size > MAX_AVATAR_BYTES) {
			setError(t("fileTooLarge") + " 2 MB")
			return
		}
		const reader = new FileReader()
		reader.onload = () => { if (typeof reader.result === "string") setCropperSrc(reader.result) }
		reader.readAsDataURL(file)
	}

	async function saveProfile() {
		if (!onSaveProfile || savingProfile) return
		setSavingProfile(true)
		setError(null)
		try {
			await onSaveProfile({ title: name.trim() || undefined, avatar })
		} catch (err) {
			setError(errorText(err, t("memberSaveFailed")))
		} finally {
			setSavingProfile(false)
		}
	}

	const memberIds = new Set(members.map((m) => m.userId))
	const q = addQuery.trim().toLowerCase()
	const addMatches = friends.filter((f) => !memberIds.has(f.id) && (q === "" || (f.displayName || "").toLowerCase().includes(q) || f.username.toLowerCase().includes(q)))

	async function addMember(friend: Friend) {
		if (!conversation || addBusy) return
		setAddBusy(true)
		setError(null)
		try {
			await api.addConversationMembers(conversation.id, [friend.username])
			setAddQuery("")
			if (onMembersChanged) onMembersChanged()
		} catch (err) {
			setError(errorText(err, t("memberAddFailed")))
		} finally {
			setAddBusy(false)
		}
	}

	// Every copy or QR makes a fresh link with the lifetime picked at that moment.
	async function createInviteLink(conversationId: string): Promise<string> {
		const res = await api.createInvite(conversationId, inviteTtl || null)
		const link = window.location.origin + "/invite/" + res.code
		setInviteLink(link)
		setInviteExpiresAt(res.expiresAt)
		return link
	}

	async function showQr() {
		if (!conversation) return
		setError(null)
		try {
			setQrLink(await createInviteLink(conversation.id))
		} catch (err) {
			setError(errorText(err, t("inviteCreateFailed")))
		}
	}

	async function copyInvite() {
		if (!conversation) return
		setError(null)
		try {
			const link = await createInviteLink(conversation.id)
			try {
				await navigator.clipboard.writeText(link)
				setInviteCopied(true)
				window.setTimeout(() => setInviteCopied(false), 2000)
			} catch {
				setInviteCopied(false)
			}
		} catch (err) {
			setError(errorText(err, t("inviteCreateFailed")))
		}
	}

	function doLeave() {
		if (!onLeave || leaving) return
		setConfirmKind("leave")
	}

	function doDelete() {
		if (!onDelete || leaving) return
		setConfirmKind("delete")
	}

	async function runConfirm() {
		if (!confirmKind || leaving) return
		setLeaving(true)
		try {
			if (confirmKind === "leave") { if (onLeave) await onLeave() }
			else { if (onDelete) await onDelete() }
			setConfirmKind(null)
		} finally {
			setLeaving(false)
		}
	}

	const roleLabel = (role: MemberRole): string => t(("role_" + role) as StringKey)
	const ttlLabel = t(INVITE_TTL_OPTIONS.find((option) => option.seconds === inviteTtl)?.label ?? "inviteTtlNever")

	return (
		<Sheet
			title={conversation?.title || t("members")}
			subtitle={String(members.length) + " · " + t("members")}
			icon={<IPeople />}
			iconShape={conversation?.kind === "channel" ? "clover" : "cookie"}
			iconTone="green"
			onClose={onClose}
			size="md"
		>
			{error ? <Banner tone="error">{error}</Banner> : null}
			{canEditProfile ? (
				<ListGroup label={t("profile")}>
					<div className="m3-list-item settings-form-item group-edit">
						<div className="group-edit-row">
							<Avatar src={avatar} label={name || "?"} seed={conversation?.id} size={64} shape={conversation?.kind === "channel" ? "channel" : "group"} />
							<div className="m3-row">
								<Button variant="tonal" onClick={() => fileRef.current?.click()}>{t("uploadPhoto")}</Button>
								{avatar ? <Button variant="text" onClick={() => setAvatar(null)}>{t("deleteAction")}</Button> : null}
							</div>
							<input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickAvatar} />
						</div>
						<TextField label={t("groupName")} value={name} maxLength={80} onChange={setName} />
						<div className="m3-row settings-form-actions">
							<Button variant="filled" busy={savingProfile} onClick={() => void saveProfile()}>{t("saveChanges")}</Button>
						</div>
					</div>
				</ListGroup>
			) : null}
			{isGroupLike && canManage ? (
				<>
					<ListGroup label={t("inviteByLink")}>
						<ListItem title={inviteCopied ? t("inviteCopied") : t("copyInviteLink")} subtitle={inviteLink ? inviteLink : undefined} icon={<ILink />} shape="circle" tone="blue" onClick={() => void copyInvite()} />
						<ListItem title={t("qrCode")} icon={<IQr />} shape="circle" tone="blue" onClick={() => void showQr()} chevron />
						<ListItem title={t("inviteTtlLabel")} subtitle={inviteExpiresAt ? t("inviteValidUntil") + " " + formatDateTime(lang, inviteExpiresAt) : ttlLabel} icon={<IClock />} shape="circle" tone="neutral" onClick={() => setTtlOpen(true)} chevron />
					</ListGroup>
					<div className="m3-list-section">
						<div className="m3-list-label">{t("addMembers")}</div>
						<TextField label={t("typeUsername")} value={addQuery} disabled={addBusy} onChange={setAddQuery} supporting={t("onlyFriendsHint")} />
						{addQuery.trim() && addMatches.length > 0 ? (
							<ListGroup>
								{addMatches.slice(0, 8).map((friend) => (
									<ListItem
										key={friend.id}
										leading={<Avatar src={friend.avatar} label={friend.displayName || friend.username} seed={friend.id} size={36} />}
										title={friend.displayName || friend.username}
										subtitle={"@" + friend.username}
										disabled={addBusy}
										onClick={() => void addMember(friend)}
										trailing={<IAdd size={18} />}
									/>
								))}
							</ListGroup>
						) : null}
					</div>
				</>
			) : null}
			<ListGroup label={t("members")}>
				{members.map((member) => {
					const editable = canManage && member.role !== "owner" && member.userId !== currentUserId
					const online = onlineUserIds.includes(member.userId)
					const presence = online ? t("online") : lastSeen?.[member.userId] ? formatLastSeen(lang, lastSeen[member.userId]) : ""
					return (
						<ListItem
							key={member.userId}
							leading={
								<span className="member-avatar">
									<Avatar src={member.avatar} label={member.displayName || member.username} seed={member.userId} size={40} />
									{online ? <span className="presence-dot online" aria-hidden="true" /> : null}
								</span>
							}
							title={<>{member.displayName || member.username}{member.isBot ? <span className="bot-badge"><IBot size={11} /> BOT</span> : null}</>}
							subtitle={"@" + member.username + (presence ? " · " + presence : "")}
							onClick={editable ? () => setRoleFor(member) : undefined}
							trailing={<span className={"role-chip role-" + member.role + (busyId === member.userId ? " busy" : "")}>{roleLabel(member.role)}</span>}
						/>
					)
				})}
			</ListGroup>
			{isGroupLike ? (
				<ListGroup>
					{isCreator && onDelete ? (
						<ListItem title={t("deleteConversationAction")} icon={<ITrash />} shape="burst" danger disabled={leaving} onClick={() => void doDelete()} />
					) : onLeave ? (
						<ListItem title={t("leaveConversationAction")} icon={<ILogout />} shape="circle" danger disabled={leaving} onClick={() => void doLeave()} />
					) : null}
				</ListGroup>
			) : null}
			{qrLink ? <QrDialog value={qrLink} title={conversation?.title || t("qrInviteTitle")} onClose={() => setQrLink(null)} /> : null}
			{ttlOpen ? (
				<ChoiceSheet
					title={t("inviteTtlLabel")}
					value={String(inviteTtl)}
					options={INVITE_TTL_OPTIONS.map((option) => ({ value: String(option.seconds), label: t(option.label) }))}
					onPick={(value) => { setInviteTtl(Number(value)); setInviteLink(null); setInviteExpiresAt(null) }}
					onClose={() => setTtlOpen(false)}
				/>
			) : null}
			{roleFor ? (
				<ChoiceSheet
					title={roleFor.displayName || roleFor.username}
					subtitle={t("roleChoose")}
					value={roleFor.role}
					options={editableRoles.map((role) => ({ value: role, label: roleLabel(role), description: t(("role_" + role + "_hint") as StringKey) }))}
					onPick={(role) => {
						const member = roleFor
						setBusyId(member.userId)
						setError(null)
						void onRoleChange(member.userId, role).catch((err: unknown) => setError(errorText(err, t("roleUpdateFailed")))).finally(() => setBusyId(null))
					}}
					onClose={() => setRoleFor(null)}
				/>
			) : null}
			{confirmKind ? (
				<Sheet title={confirmKind === "delete" ? t("deleteConfirm") : t("leaveConfirm")} icon={confirmKind === "delete" ? <ITrash /> : <ILogout />} iconTone="error" iconShape="burst" onClose={() => { if (!leaving) setConfirmKind(null) }} size="sm" role="alertdialog"
					actions={
						<>
							<Button variant="text" disabled={leaving} onClick={() => setConfirmKind(null)}>{t("cancel")}</Button>
							<Button variant="danger" busy={leaving} onClick={() => void runConfirm()}>{confirmKind === "delete" ? t("deleteConversationAction") : t("leaveConversationAction")}</Button>
						</>
					}
				>
					<p className="settings-intro">{confirmKind === "delete" ? t("deleteConfirmCopy") : t("leaveConfirmCopy")}</p>
				</Sheet>
			) : null}
			{cropperSrc ? <AvatarCropper src={cropperSrc} onCancel={() => setCropperSrc(null)} onConfirm={(dataUrl) => { setCropperSrc(null); setAvatar(dataUrl) }} /> : null}
		</Sheet>
	)
}
