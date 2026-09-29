import { afterEach, beforeEach, mock, test } from "node:test"
import assert from "node:assert/strict"
import { watchActivity } from "../src/lib/activity"

// A tiny stand-in for the browser: visibility, focus and event listeners.
type Listener = () => void
function fakeDom() {
	const listeners = new Map<string, Set<Listener>>()
	const add = (name: string, fn: Listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn) }
	const remove = (name: string, fn: Listener) => listeners.get(name)?.delete(fn)
	const state = { visibility: "visible", focused: true }
	const g = globalThis as Record<string, unknown>
	g.document = { get visibilityState() { return state.visibility }, hasFocus: () => state.focused, addEventListener: add, removeEventListener: remove }
	g.window = { addEventListener: add, removeEventListener: remove }
	const fire = (name: string) => { for (const fn of listeners.get(name) ?? []) fn() }
	return { state, fire }
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval"] }))
afterEach(() => {
	mock.timers.reset()
	const g = globalThis as Record<string, unknown>
	delete g.document
	delete g.window
	delete g.FrontierXNative
})

test("a browser tab counts as away 5 seconds after losing focus, and back at once", () => {
	const dom = fakeDom()
	const changes: boolean[] = []
	const watcher = watchActivity((active) => changes.push(active))
	assert.equal(watcher.active(), true)
	dom.state.focused = false
	dom.fire("blur")
	mock.timers.tick(4900)
	assert.deepEqual(changes, [], "not yet: a quick glance elsewhere is not away")
	mock.timers.tick(200)
	assert.deepEqual(changes, [false])
	dom.state.focused = true
	dom.fire("focus")
	assert.deepEqual(changes, [false, true], "coming back counts immediately")
	watcher.stop()
})

test("switching tabs back and forth quickly does not flicker", () => {
	const dom = fakeDom()
	const changes: boolean[] = []
	const watcher = watchActivity((active) => changes.push(active))
	dom.state.visibility = "hidden"
	dom.fire("visibilitychange")
	mock.timers.tick(2000)
	dom.state.visibility = "visible"
	dom.fire("visibilitychange")
	mock.timers.tick(10000)
	assert.deepEqual(changes, [])
	watcher.stop()
})

test("the desktop window hidden in the tray counts as away even without events", () => {
	fakeDom()
	let shellFocused = true
	;(globalThis as Record<string, unknown>).FrontierXNative = { platform: "desktop", isFocused: () => shellFocused }
	const changes: boolean[] = []
	const watcher = watchActivity((active) => changes.push(active))
	shellFocused = false
	mock.timers.tick(5000) // the periodic re-check notices
	mock.timers.tick(5000) // and the grace period passes
	assert.deepEqual(changes, [false])
	watcher.stop()
})

test("on Android the app going to the background is final and immediate", () => {
	fakeDom()
	;(globalThis as Record<string, unknown>).FrontierXNative = { platform: "android" }
	const changes: boolean[] = []
	const watcher = watchActivity((active) => changes.push(active))
	watcher.setNativeInFront(false)
	assert.deepEqual(changes, [false])
	watcher.setNativeInFront(true)
	assert.deepEqual(changes, [false, true])
	watcher.stop()
})
