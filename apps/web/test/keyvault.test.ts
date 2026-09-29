import { test } from "node:test"
import assert from "node:assert/strict"
import {
	accountKeyCheck,
	cekCheck,
	equalBytes,
	fingerprint,
	generateIdentity,
	importCek,
	linkCode,
	newAccountKey,
	newConversationKey,
	newKeyId,
	newLinkKeyPair,
	newRecoveryKey,
	openAkFromLink,
	openAkWithIdentity,
	openAkWithPassword,
	openAkWithRecovery,
	openCek,
	openIdentity,
	openMessage,
	parseEnvelope,
	parseRecoveryKey,
	publicKeyOf,
	safetyNumber,
	sealAkForIdentity,
	sealAkForLink,
	sealAkWithPassword,
	sealAkWithRecovery,
	sealCek,
	sealIdentity,
	sealMessage,
	unwrapShare,
	verifyAccountKey,
	verifyCek,
	wrapShare,
} from "../src/lib/keyvault"
import { generateIdentityKeyPair, unwrapConversationKey, wrapConversationKey } from "../src/lib/keys"
import { encryptWithKey } from "../src/lib/crypto"

test("the account key check only opens with the right key and account", async () => {
	const ak = newAccountKey()
	const check = await accountKeyCheck(ak, "user_a")
	assert.equal(await verifyAccountKey(ak, "user_a", check), true)
	assert.equal(await verifyAccountKey(newAccountKey(), "user_a", check), false)
	assert.equal(await verifyAccountKey(ak, "user_b", check), false)
	assert.equal(await verifyAccountKey(ak, "user_a", null), false)
})

test("password slots open with the password and only for their account", async () => {
	const ak = newAccountKey()
	const slot = await sealAkWithPassword(ak, "correct horse", "user_a", 100000)
	assert.equal(slot.kdf.alg, "PBKDF2-SHA256")
	assert.ok(equalBytes(await openAkWithPassword(slot, "correct horse", "user_a"), ak))
	await assert.rejects(() => openAkWithPassword(slot, "wrong horse", "user_a"))
	await assert.rejects(() => openAkWithPassword(slot, "correct horse", "user_b"))
	// Unicode forms of the same password agree.
	const composed = await sealAkWithPassword(ak, "pässword", "user_a", 100000)
	assert.ok(equalBytes(await openAkWithPassword(composed, "pässword", "user_a"), ak))
})

test("recovery keys carry a checksum and open their slot", async () => {
	const ak = newAccountKey()
	const { code, bytes } = await newRecoveryKey()
	assert.match(code, /^([0-9A-HJKMNP-TV-Z]{4}-){8}[0-9A-HJKMNP-TV-Z]{4}$/)
	const parsed = await parseRecoveryKey(code.toLowerCase().replace(/-/g, " "))
	assert.ok(parsed && equalBytes(parsed, bytes))
	// One wrong character is caught before anything is tried.
	const typo = (code[0] === "A" ? "B" : "A") + code.slice(1)
	assert.equal(await parseRecoveryKey(typo), null)
	assert.equal(await parseRecoveryKey("short"), null)
	const slot = await sealAkWithRecovery(ak, bytes, "user_a")
	assert.ok(equalBytes(await openAkWithRecovery(slot, bytes, "user_a"), ak))
	const otherRecovery = (await newRecoveryKey()).bytes
	await assert.rejects(() => openAkWithRecovery(slot, otherRecovery, "user_a"))
})

test("identity slots and vault items round-trip", async () => {
	const ak = newAccountKey()
	const identity = await generateIdentity()
	assert.equal(await publicKeyOf(identity.privateKey), identity.publicKey)
	const slot = await sealAkForIdentity(ak, identity.publicKey, "user_a")
	assert.equal(slot.label, await fingerprint(identity.publicKey))
	assert.ok(equalBytes(await openAkWithIdentity(slot, identity.privateKey, "user_a"), ak))
	const other = await generateIdentity()
	await assert.rejects(() => openAkWithIdentity(slot, other.privateKey, "user_a"))

	const item = await sealIdentity(ak, identity, "user_a")
	assert.deepEqual(await openIdentity(ak, item, "user_a"), identity)
	await assert.rejects(() => openIdentity(ak, { ...item, itemId: "0".repeat(32) }, "user_a"))
})

test("conversation keys: vault copies, checks, shares for current and legacy keys", async () => {
	const ak = newAccountKey()
	const cek = newConversationKey()
	const keyId = newKeyId()
	assert.match(keyId, /^k_[A-Za-z0-9_-]{16}$/)
	const vaulted = await sealCek(ak, cek, "user_a", "conv_1", keyId)
	assert.ok(equalBytes(await openCek(ak, vaulted, "user_a", "conv_1", keyId), cek))
	await assert.rejects(() => openCek(ak, vaulted, "user_a", "conv_2", keyId))

	const check = await cekCheck(cek, "conv_1", keyId)
	assert.equal(await verifyCek(cek, "conv_1", keyId, check), true)
	assert.equal(await verifyCek(newConversationKey(), "conv_1", keyId, check), false)
	assert.equal(await verifyCek(cek, "conv_1", "k_other", check), false)

	const bob = await generateIdentity()
	const share = await wrapShare(bob.publicKey, "conv_1", keyId, cek)
	assert.ok(equalBytes(await unwrapShare(bob.privateKey, "conv_1", keyId, share), cek))
	await assert.rejects(() => unwrapShare(bob.privateKey, "conv_1", "k_different0", share))

	// "legacy" copies are interchangeable with the first key system's.
	const old = await generateIdentityKeyPair()
	const fromOldClient = await wrapConversationKey(old.publicKey, "conv_1", cek)
	assert.ok(equalBytes(await unwrapShare(old.privateKey, "conv_1", "legacy", fromOldClient), cek))
	const forOldClient = await wrapShare(old.publicKey, "conv_1", "legacy", cek)
	assert.ok(equalBytes(await unwrapConversationKey(old.privateKey, "conv_1", forOldClient), cek))
})

test("fx2 messages are bound to their conversation and key; fx1 still opens", async () => {
	const cek = newConversationKey()
	const key = await importCek(cek)
	const sealed = await sealMessage(key, "conv_1", "k_abcdefghijklmnop", "hello")
	const envelope = parseEnvelope(sealed)
	assert.equal(envelope?.version, 2)
	assert.equal(envelope && envelope.version === 2 ? envelope.keyId : "", "k_abcdefghijklmnop")
	assert.equal(await openMessage(key, "conv_1", envelope), "hello")
	await assert.rejects(() => openMessage(key, "conv_2", envelope))
	await assert.rejects(() => openMessage(key, "conv_1", parseEnvelope(sealed.replace("k_abcdefghijklmnop", "k_zzzzzzzzzzzzzzzz"))))
	const legacy = await encryptWithKey(key, "old message")
	assert.equal(await openMessage(key, "conv_1", parseEnvelope(legacy)), "old message")
	assert.equal(parseEnvelope("plain text"), null)
})

test("device linking: the code is stable and the sealed key only opens on the new device", async () => {
	const ak = newAccountKey()
	const device = await newLinkKeyPair()
	const code = await linkCode(device.publicKey)
	assert.match(code, /^\d{4} \d{4} \d{4} \d{4}$/)
	assert.equal(await linkCode(device.publicKey), code)
	assert.notEqual(await linkCode((await newLinkKeyPair()).publicKey), code)
	const response = await sealAkForLink(ak, device.publicKey, "user_a")
	assert.ok(equalBytes(await openAkFromLink(response, device.privateKey, "user_a"), ak))
	await assert.rejects(async () => openAkFromLink(response, (await newLinkKeyPair()).privateKey, "user_a"))
	await assert.rejects(() => openAkFromLink(response, device.privateKey, "user_b"))
})

test("safety numbers match on both sides", async () => {
	const a = await generateIdentity()
	const b = await generateIdentity()
	const one = await safetyNumber(a.publicKey, b.publicKey)
	assert.equal(one, await safetyNumber(b.publicKey, a.publicKey))
	assert.match(one, /^(\d{5} ){11}\d{5}$/)
	assert.notEqual(one, await safetyNumber(a.publicKey, (await generateIdentity()).publicKey))
})
