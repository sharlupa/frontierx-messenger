import { test } from "node:test"
import assert from "node:assert/strict"
import { LANGS, langFromTag, plural, translate, translateServerError } from "../src/lib/i18n"
import { encodeLinkMessage, parseLinkMessage, LINK_PREFIX } from "../src/lib/linkmsg"

test("plural forms follow each language's rules", () => {
	assert.equal(plural("en", "votes", 1), "1 vote")
	assert.equal(plural("en", "votes", 5), "5 votes")
	assert.equal(plural("ru", "votes", 1), "1 голос")
	assert.equal(plural("ru", "votes", 3), "3 голоса")
	assert.equal(plural("ru", "votes", 11), "11 голосов")
	assert.equal(plural("ru", "comments", 21), "21 комментарий")
})

test("language registry drives the switcher and browser detection", () => {
	assert.deepEqual(LANGS.map((item) => item.code), ["ru", "en"])
	assert.equal(langFromTag("ru-RU"), "ru")
	assert.equal(langFromTag("de-DE"), "en")
	assert.equal(translate("ru", "loadingApp"), "Загрузка FrontierX...")
})

test("server errors are translated when known and passed through otherwise", () => {
	assert.equal(translateServerError("ru", "invalid credentials"), "Неверный логин или пароль")
	assert.equal(translateServerError("ru", "too many attempts, retry in 42 seconds"), "Слишком много попыток, повторите через 42 с")
	assert.equal(translateServerError("en", "invalid credentials"), "invalid credentials")
	assert.equal(translateServerError("ru", "something new"), "something new")
})

test("link cards drop script urls and remote images", () => {
	const evil = LINK_PREFIX + JSON.stringify({ text: "hi", preview: { url: "javascript:alert(1)", title: "x", description: null, siteName: null, image: null } })
	assert.deepEqual(parseLinkMessage(evil), { text: "hi", preview: null })
	const remote = encodeLinkMessage({ text: "t", preview: { url: "https://example.com/", title: "E", description: null, siteName: null, image: "https://tracker.example/p.png" } })
	const parsed = parseLinkMessage(remote)
	assert.equal(parsed?.preview?.url, "https://example.com/")
	assert.equal(parsed?.preview?.image, null)
})
