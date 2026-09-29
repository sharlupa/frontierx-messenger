import { test } from "node:test"
import assert from "node:assert/strict"
import { startTestServer, type TestServer } from "../../api/test/helpers"
import { api, setApiBase } from "../src/lib/api"
import { setSession, getDeviceId } from "../src/lib/session"
import { addIdentities } from "../src/lib/keystore"
import * as kv from "../src/lib/keyvault"
import { Keyring } from "../src/lib/keyring"
import { changePassword, createRecoveryKey, setupKeys, startLink, approveLink, startOver, unlockWithPassword, unlockWithRecoveryKey, type KeySetup } from "../src/lib/accountKeys"
import { generateIdentityKeyPair, wrapConversationKey, wrapIdentityWithPassword, randomConversationKey, importConversationKey } from "../src/lib/keys"
import { encryptWithKey } from "../src/lib/crypto"
import { hashPassword } from "@frontierx/crypto"

// End-to-end key flows against a real API: every "device" is its own local
// storage; nothing is shared between devices except the server.

class Device {
	private data = new Map<string, string>()
	use(): void {
		const data = this.data
		;(globalThis as Record<string, unknown>).localStorage = {
			getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
			setItem: (key: string, value: string) => void data.set(key, String(value)),
			removeItem: (key: string) => void data.delete(key),
			key: (index: number) => Array.from(data.keys())[index] ?? null,
			get length() {
				return data.size
			},
			clear: () => data.clear(),
		}
	}
	has(key: string): boolean {
		return this.data.has(key)
	}
	set(key: string, value: string): void {
		this.data.set(key, value)
	}
}

;(globalThis as Record<string, unknown>).window = globalThis

function ready(setup: KeySetup): Keyring {
	assert.equal(setup.status, "ready", "expected unlocked keys, got " + JSON.stringify(setup.status === "locked" ? setup.info : setup.status))
	if (setup.status !== "ready") throw new Error("locked")
	return new Keyring(setup.session)
}

async function registerOn(device: Device, username: string, password: string): Promise<{ id: string; ring: Keyring }> {
	device.use()
	const identity = await kv.generateIdentity()
	const res = await api.register({ username, password, displayName: username, publicKey: identity.publicKey, deviceId: getDeviceId() })
	addIdentities(res.user.id, [identity])
	setSession(res.token, res.user)
	const ring = ready(await setupKeys(res.user.id, password))
	return { id: res.user.id, ring }
}

async function loginOn(device: Device, username: string, password: string): Promise<{ id: string; setup: KeySetup }> {
	device.use()
	const res = await api.login({ username, password, deviceId: getDeviceId() })
	setSession(res.token, res.user)
	return { id: res.user.id, setup: await setupKeys(res.user.id, password) }
}

async function befriend(a: Device, b: Device, bName: string, aName: string): Promise<string> {
	a.use()
	await api.sendFriendRequest(bName)
	b.use()
	const res = await api.sendFriendRequest(aName)
	return (res.conversation as { id: string }).id
}

// What the reset-by-email route does, without the email.
function resetPassword(s: TestServer, userId: string, password: string): void {
	s.app.store.updateUserPassword(userId, hashPassword(password))
	const at = new Date().toISOString()
	s.app.store.markPasswordSlotsStale(userId, at)
	s.app.store.setPasswordChangedAt(userId, at)
	s.app.store.deleteAllSessionsForUser(userId)
}

async function send(device: Device, ring: Keyring, conversationId: string, text: string): Promise<string> {
	device.use()
	const res = await ring.sealAndSend(conversationId, text, (ciphertext) => api.sendMessage(conversationId, { ciphertext }))
	await ring.flushVault()
	return res.message.id
}

async function readAll(device: Device, ring: Keyring, conversationId: string): Promise<string[]> {
	device.use()
	const res = await api.listMessages(conversationId, { limit: 200 })
	const out: string[] = []
	for (const message of res.messages) out.push(await ring.decrypt(conversationId, message.ciphertext))
	return out
}

test("history follows the account to every device, through password resets", async (t) => {
	const s = await startTestServer()
	t.after(() => s.close())
	setApiBase(s.base)
	const laptop = new Device()
	const friendPhone = new Device()
	const alice = await registerOn(laptop, "alice", "first-password")
	const bob = await registerOn(friendPhone, "bob", "bob-password")
	const chat = await befriend(laptop, friendPhone, "bob", "alice")

	await send(laptop, alice.ring, chat, "hello bob")
	await send(friendPhone, bob.ring, chat, "hi alice")
	laptop.use()
	const self = (await api.listConversations()).conversations.find((c) => c.isSelf)
	assert.ok(self)
	await send(laptop, alice.ring, self.id, "note to self")

	// A brand-new browser: the password alone brings back everything.
	const tablet = new Device()
	const onTablet = await loginOn(tablet, "alice", "first-password")
	const tabletRing = ready(onTablet.setup)
	await tabletRing.preload()
	assert.deepEqual(await readAll(tablet, tabletRing, chat), ["hello bob", "hi alice"])
	assert.deepEqual(await readAll(tablet, tabletRing, self.id), ["note to self"])

	// Password reset by e-mail: the old slot is stale, a new device is locked.
	resetPassword(s, alice.id, "second-password")
	const fresh = new Device()
	const locked = await loginOn(fresh, "alice", "second-password")
	assert.equal(locked.setup.status, "locked")
	if (locked.setup.status === "locked") {
		assert.equal(locked.setup.info.hasStalePasswordSlot, true)
		assert.equal(locked.setup.info.triedPassword, true)
	}
	// The previous password unlocks it once and the keys get sealed anew.
	fresh.use()
	await assert.rejects(() => unlockWithPassword(alice.id, "wrong-old-password", "second-password"))
	const unlocked = ready(await unlockWithPassword(alice.id, "first-password", "second-password"))
	await unlocked.preload()
	assert.deepEqual(await readAll(fresh, unlocked, self.id), ["note to self"])
	// From now on the new password is enough on any device.
	const another = new Device()
	const direct = ready((await loginOn(another, "alice", "second-password")).setup)
	await direct.preload()
	assert.deepEqual(await readAll(another, direct, chat), ["hello bob", "hi alice"])

	// Reset again; this time the old laptop (which kept its keys) is the way back.
	resetPassword(s, alice.id, "third-password")
	const onLaptop = await loginOn(laptop, "alice", "third-password")
	assert.equal(onLaptop.setup.status, "ready")
	const later = new Device()
	assert.equal((await loginOn(later, "alice", "third-password")).setup.status, "ready")
})

test("recovery key and device approval unlock a locked account", async (t) => {
	const s = await startTestServer()
	t.after(() => s.close())
	setApiBase(s.base)
	const phone = new Device()
	const carol = await registerOn(phone, "carol", "carol-password-1")
	phone.use()
	const self = (await api.listConversations()).conversations.find((c) => c.isSelf)
	assert.ok(self)
	await send(phone, carol.ring, self.id, "secret plans")
	phone.use()
	const code = await createRecoveryKey(carol.ring.session)

	resetPassword(s, carol.id, "carol-password-2")
	const desktop = new Device()
	const locked = await loginOn(desktop, "carol", "carol-password-2")
	assert.equal(locked.setup.status, "locked")
	if (locked.setup.status === "locked") assert.equal(locked.setup.info.hasRecoverySlot, true)
	desktop.use()
	await assert.rejects(() => unlockWithRecoveryKey(carol.id, "0000-0000-0000-0000-0000-0000-0000-0000-0000", "carol-password-2"))
	const viaRecovery = ready(await unlockWithRecoveryKey(carol.id, code, "carol-password-2"))
	await viaRecovery.preload()
	assert.deepEqual(await readAll(desktop, viaRecovery, self.id), ["secret plans"])

	// Approval from a device that holds the keys.
	resetPassword(s, carol.id, "carol-password-3")
	const tv = new Device()
	assert.equal((await loginOn(tv, "carol", "carol-password-3")).setup.status, "locked")
	tv.use()
	const attempt = await startLink(carol.id, "TV", "carol-password-3")
	// The trusted device signs in again (its local copy keeps it unlocked).
	const trusted = await loginOn(desktop, "carol", "carol-password-3")
	const trustedRing = ready(trusted.setup)
	desktop.use()
	const pending = await api.pendingLinks()
	assert.equal(pending.requests.length, 1)
	assert.equal(await kv.linkCode(pending.requests[0].ephemeralPublicKey), attempt.code)
	await approveLink(trustedRing.session, pending.requests[0])
	tv.use()
	const linked = ready(await attempt.wait({ cancelled: false }))
	await linked.preload()
	assert.deepEqual(await readAll(tv, linked, self.id), ["secret plans"])
})

test("accounts from the first key system migrate without losing a message", async (t) => {
	const s = await startTestServer()
	t.after(() => s.close())
	setApiBase(s.base)
	// Two users set up the way the old client did it.
	const oldPc = new Device()
	const oldPhone = new Device()
	const legacy: Record<string, { id: string; identity: { publicKey: string; privateKey: string } }> = {}
	for (const [device, name] of [[oldPc, "dora"], [oldPhone, "emil"]] as const) {
		device.use()
		const identity = await generateIdentityKeyPair()
		const res = await api.register({ username: name, password: name + "-password", displayName: name, publicKey: identity.publicKey, deviceId: getDeviceId() })
		setSession(res.token, res.user)
		device.set("fx.idpriv." + res.user.id, identity.privateKey)
		device.set("fx.idpriv", identity.privateKey)
		device.set("fx.idowner", res.user.id)
		await api.putKeyBackup(await wrapIdentityWithPassword(identity, name + "-password"))
		legacy[name] = { id: res.user.id, identity }
	}
	const chat = await befriend(oldPc, oldPhone, "emil", "dora")
	// The old client's single conversation key and an fx1 message.
	oldPc.use()
	const cek = randomConversationKey()
	const entries = []
	for (const name of ["dora", "emil"]) {
		const wrapped = await wrapConversationKey(legacy[name].identity.publicKey, chat, cek)
		entries.push({ memberId: legacy[name].id, ...wrapped })
	}
	await api.putConversationKeys(chat, entries)
	await api.sendMessage(chat, { ciphertext: await encryptWithKey(await importConversationKey(cek), "from the old app") })

	// Dora's old PC runs the new client, restoring the session without a password.
	oldPc.use()
	const doraRing = ready(await setupKeys(legacy.dora.id, null))
	assert.deepEqual(await readAll(oldPc, doraRing, chat), ["from the old app"])
	assert.equal(oldPc.has("fx.idpriv." + legacy.dora.id), false)
	await send(oldPc, doraRing, chat, "from the new app")

	// Emil signs in on a new phone: the old password backup carries him over.
	const newPhone = new Device()
	const emil = await loginOn(newPhone, "emil", "emil-password")
	const emilRing = ready(emil.setup)
	assert.deepEqual(await readAll(newPhone, emilRing, chat), ["from the old app", "from the new app"])
	// The chat keeps its old key: nothing was re-keyed.
	newPhone.use()
	assert.equal((await api.conversationKeys(chat)).currentKeyId, "legacy")
	// And Dora's other devices now use the account key, not the loose copy.
	const doraTablet = new Device()
	const tabletRing = ready((await loginOn(doraTablet, "dora", "dora-password")).setup)
	await tabletRing.preload()
	assert.deepEqual(await readAll(doraTablet, tabletRing, chat), ["from the old app", "from the new app"])
})

test("groups: newcomers get the history, leavers do not get new keys", async (t) => {
	const s = await startTestServer()
	t.after(() => s.close())
	setApiBase(s.base)
	const devices = { finn: new Device(), gina: new Device(), hugo: new Device() }
	const finn = await registerOn(devices.finn, "finn", "finn-password")
	const gina = await registerOn(devices.gina, "gina", "gina-password")
	const hugo = await registerOn(devices.hugo, "hugo", "hugo-password")
	await befriend(devices.finn, devices.gina, "gina", "finn")
	await befriend(devices.finn, devices.hugo, "hugo", "finn")
	devices.finn.use()
	const group = (await api.createConversation({ kind: "group", title: "Crew", memberUsernames: ["gina"] })).conversation.id
	await send(devices.finn, finn.ring, group, "before hugo")
	await send(devices.gina, gina.ring, group, "gina here")

	devices.finn.use()
	await api.addConversationMembers(group, ["hugo"])
	// Any member's device that holds the keys hands them over.
	devices.gina.use()
	await gina.ring.syncPending()
	assert.deepEqual(await readAll(devices.hugo, hugo.ring, group), ["before hugo", "gina here"])

	// Gina leaves: the next message goes out under a new key.
	devices.gina.use()
	await api.leaveConversation(group)
	await send(devices.finn, finn.ring, group, "after gina")
	devices.finn.use()
	const keys = await api.conversationKeys(group)
	assert.equal(keys.epochs.length, 2)
	assert.equal(keys.rekeyNeeded, false)
	assert.deepEqual(await readAll(devices.hugo, hugo.ring, group), ["before hugo", "gina here", "after gina"])
	devices.gina.use()
	await assert.rejects(() => api.conversationKeys(group))
})

test("starting over gets chats back from the other members", async (t) => {
	const s = await startTestServer()
	t.after(() => s.close())
	setApiBase(s.base)
	const ivy = new Device()
	const jack = new Device()
	const ivyAcc = await registerOn(ivy, "ivy", "ivy-password")
	const jackAcc = await registerOn(jack, "jack", "jack-password")
	const chat = await befriend(ivy, jack, "jack", "ivy")
	await send(ivy, ivyAcc.ring, chat, "keep this")
	// Ivy lost every device and never saved a recovery key; the password was reset.
	resetPassword(s, ivyAcc.id, "ivy-new-password")
	const newDevice = new Device()
	assert.equal((await loginOn(newDevice, "ivy", "ivy-new-password")).setup.status, "locked")
	newDevice.use()
	const restarted = ready(await startOver(ivyAcc.id, "ivy-new-password"))
	// Jack's device notices and hands the chat key to Ivy's new identity.
	jack.use()
	await jackAcc.ring.syncPending()
	assert.deepEqual(await readAll(newDevice, restarted, chat), ["keep this"])
	await send(newDevice, restarted, chat, "back again")
	assert.deepEqual(await readAll(jack, jackAcc.ring, chat), ["keep this", "back again"])
})

test("changing the password keeps every device able to sign in", async (t) => {
	const s = await startTestServer()
	t.after(() => s.close())
	setApiBase(s.base)
	const one = new Device()
	const kim = await registerOn(one, "kim", "kim-password-1")
	one.use()
	await assert.rejects(() => changePassword(kim.ring.session, "not-it", "kim-password-2", false))
	await changePassword(kim.ring.session, "kim-password-1", "kim-password-2", false)
	const two = new Device()
	assert.equal((await loginOn(two, "kim", "kim-password-2")).setup.status, "ready")
	await assert.rejects(() => loginOn(new Device(), "kim", "kim-password-1"))
})
