import { test } from "node:test"
import assert from "node:assert/strict"
import { generateIdentityKeyPair, randomConversationKey, wrapConversationKey, unwrapConversationKey, importConversationKey } from "../src/lib/keys"
import { encryptWithKey, decryptWithKey } from "../src/lib/crypto"

test("two identities agree on the same wrapped conversation key", async () => {
  const alice = await generateIdentityKeyPair()
  const bob = await generateIdentityKeyPair()
  const conversationId = "conv-key-1"
  const cek = randomConversationKey()
  const wrappedForBob = await wrapConversationKey(bob.publicKey, conversationId, cek)
  const recovered = await unwrapConversationKey(bob.privateKey, conversationId, wrappedForBob)
  assert.deepEqual(Array.from(recovered), Array.from(cek))
  await assert.rejects(() => unwrapConversationKey(alice.privateKey, conversationId, wrappedForBob))
})

test("a wrapped key does not unwrap under a different conversation id", async () => {
  const bob = await generateIdentityKeyPair()
  const cek = randomConversationKey()
  const wrapped = await wrapConversationKey(bob.publicKey, "conv-a", cek)
  await assert.rejects(() => unwrapConversationKey(bob.privateKey, "conv-b", wrapped))
})

test("messages encrypt and decrypt with the shared conversation key", async () => {
  const bob = await generateIdentityKeyPair()
  const conversationId = "conv-key-2"
  const cek = randomConversationKey()
  const wrapped = await wrapConversationKey(bob.publicKey, conversationId, cek)
  const bobCek = await unwrapConversationKey(bob.privateKey, conversationId, wrapped)
  const senderKey = await importConversationKey(cek)
  const receiverKey = await importConversationKey(bobCek)
  const packed = await encryptWithKey(senderKey, "hello over ecdh")
  const opened = await decryptWithKey(receiverKey, packed)
  assert.equal(opened, "hello over ecdh")
})
