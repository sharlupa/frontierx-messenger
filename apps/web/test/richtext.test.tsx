import { test } from "node:test"
import assert from "node:assert/strict"
import { mentionsUser, renderRichText, stripFormatting } from "../src/lib/richtext"

test("stripFormatting returns the plain reading of a message", () => {
  assert.equal(stripFormatting("*bold* and _italic_"), "bold and italic")
  assert.equal(stripFormatting("~gone~ `code`"), "gone code")
  assert.equal(stripFormatting("> quoted line"), "quoted line")
  assert.equal(stripFormatting("```\nblock\n```"), "\nblock\n")
  assert.equal(stripFormatting("nothing to strip"), "nothing to strip")
})

test("mentions match whole names only", () => {
  assert.equal(mentionsUser("hi @anna, look", "anna"), true)
  assert.equal(mentionsUser("@anna", "anna"), true)
  assert.equal(mentionsUser("mail to anna@example.com", "example"), false)
  assert.equal(mentionsUser("hi @annabel", "anna"), false)
  assert.equal(mentionsUser("hi @ANNA", "anna"), true)
  assert.equal(mentionsUser("no mention here", "anna"), false)
  assert.equal(mentionsUser("", "anna"), false)
})

test("nested markers render without hanging", () => {
  // The parser recurses into bold/italic; a shared global regex used to loop
  // forever here and wedge the tab.
  const started = Date.now()
  const node = renderRichText("*жирный _и курсив_ и `код`* и ~зачёркнутый~ @anna https://example.com")
  assert.ok(node)
  assert.ok(Date.now() - started < 1000)
  const deep = renderRichText("*a*".repeat(200) + " _b_".repeat(200))
  assert.ok(deep)
  assert.ok(Date.now() - started < 2000)
})

test("plain text passes through untouched", () => {
  assert.equal(renderRichText(""), "")
  const plain = renderRichText("просто текст")
  assert.ok(plain)
})
