/* FrontierX site — Material 3 Expressive motion without libraries.
   Shapes are radius functions of the angle, so any two can be blended point by
   point: that is what makes the morphs. Everything stays still when the visitor
   asked the system for reduced motion. */
;(function () {
	"use strict"

	var TAU = Math.PI * 2
	var SAMPLES = 120
	var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)

	function lobes(count, depth, sharp) {
		sharp = sharp || 1
		return function (t) {
			var w = Math.cos(count * t)
			var s = (w < 0 ? -1 : 1) * Math.pow(Math.abs(w), sharp)
			return 1 - depth + depth * (s + 1) / 2
		}
	}
	function oval(ratio) {
		return function (t) {
			var b = 1 / ratio
			return b / Math.sqrt(Math.pow(b * Math.cos(t), 2) + Math.pow(Math.sin(t), 2))
		}
	}
	function superellipse(n, stretch) {
		return function (t) {
			var c = Math.abs(Math.cos(t))
			var s = Math.abs(Math.sin(t)) * (stretch || 1)
			return 1 / Math.pow(Math.pow(c, n) + Math.pow(s, n), 1 / n)
		}
	}
	// The M3 Expressive shape set, approximated.
	var SHAPES = {
		circle: function () { return 1 },
		cookie4: lobes(4, 0.16),
		cookie6: lobes(6, 0.14),
		cookie9: lobes(9, 0.12),
		cookie12: lobes(12, 0.09),
		clover4: lobes(4, 0.34, 0.5),
		clover8: lobes(8, 0.2, 0.5),
		burst: lobes(10, 0.22, 0.55),
		sunny: lobes(8, 0.08),
		pentagon: lobes(5, 0.15, 0.8),
		gem: lobes(6, 0.1, 0.8),
		pill: superellipse(4, 1.5),
		square: superellipse(5, 1),
		oval: oval(1.35)
	}

	var cache = {}
	function radii(name) {
		if (cache[name]) return cache[name]
		var fn = SHAPES[name] || SHAPES.circle
		var out = []
		var max = 0
		for (var i = 0; i < SAMPLES; i++) {
			var r = fn((i / SAMPLES) * TAU)
			out.push(r)
			if (r > max) max = r
		}
		for (var j = 0; j < out.length; j++) out[j] /= max
		cache[name] = out
		return out
	}

	function pathFor(list, size, rotation, scale) {
		var c = size / 2
		var r0 = (size / 2) * (scale || 1)
		var d = ""
		for (var i = 0; i < list.length; i++) {
			var a = (i / list.length) * TAU + rotation
			d += (i ? "L" : "M") + (c + Math.cos(a) * list[i] * r0).toFixed(2) + " " + (c + Math.sin(a) * list[i] * r0).toFixed(2)
		}
		return d + "Z"
	}

	function blend(a, b, k) {
		var out = new Array(a.length)
		for (var i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * k
		return out
	}

	// Damped spring with a little overshoot.
	function spring(t) {
		if (t <= 0) return 0
		if (t >= 1) return 1
		return 1 - Math.exp(-6.5 * t) * Math.cos(8.2 * t)
	}

	var SVGNS = "http://www.w3.org/2000/svg"
	function makeSvg(size, cls) {
		var svg = document.createElementNS(SVGNS, "svg")
		svg.setAttribute("viewBox", "0 0 " + size + " " + size)
		svg.setAttribute("aria-hidden", "true")
		svg.setAttribute("class", cls)
		var path = document.createElementNS(SVGNS, "path")
		svg.appendChild(path)
		return { svg: svg, path: path }
	}

	/* 1. Looping morphs: <div data-morph="burst cookie9 pentagon pill sunny oval"> */
	function loopMorph(el) {
		var names = (el.getAttribute("data-morph") || "burst cookie9 pentagon pill sunny oval").split(/\s+/)
		var size = 200
		var parts = makeSvg(size, "morph-svg")
		el.appendChild(parts.svg)
		var hold = Number(el.getAttribute("data-hold") || 900)
		var morphMs = Number(el.getAttribute("data-speed") || 900)
		var spin = Number(el.getAttribute("data-spin") || 16000)
		if (reduce) {
			parts.path.setAttribute("d", pathFor(radii(names[0]), size, 0, 0.98))
			return
		}
		var start = performance.now()
		var visible = true
		if ("IntersectionObserver" in window) {
			new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting }).observe(el)
		}
		function frame(now) {
			if (visible) {
				var elapsed = now - start
				var cycle = morphMs + hold
				var step = Math.floor(elapsed / cycle)
				var k = spring(Math.min(1, (elapsed % cycle) / morphMs))
				var from = radii(names[step % names.length])
				var to = radii(names[(step + 1) % names.length])
				var rotation = (elapsed / spin) * TAU + (step + k) * (Math.PI / 4)
				parts.path.setAttribute("d", pathFor(blend(from, to, k), size, rotation, 0.98))
			}
			requestAnimationFrame(frame)
		}
		requestAnimationFrame(frame)
	}

	/* 2. Shape containers that morph on hover or focus:
	      <span class="shape" data-shape="cookie9" data-shape-to="clover8"> */
	function hoverShape(el) {
		var size = 100
		var parts = makeSvg(size, "shape-svg")
		el.insertBefore(parts.svg, el.firstChild)
		var rest = radii(el.getAttribute("data-shape") || "cookie9")
		var active = radii(el.getAttribute("data-shape-to") || "circle")
		var current = rest
		var rotation = 0
		parts.path.setAttribute("d", pathFor(rest, size, 0, 1))
		if (reduce) return
		var anim = null
		function go(target, turn) {
			var from = current
			var fromRot = rotation
			var t0 = performance.now()
			if (anim) cancelAnimationFrame(anim)
			function tick(now) {
				var t = Math.min(1, (now - t0) / 650)
				var k = spring(t)
				current = blend(from, target, k)
				rotation = fromRot + turn * k
				parts.path.setAttribute("d", pathFor(current, size, rotation, 1))
				if (t < 1) anim = requestAnimationFrame(tick)
				else { current = target; anim = null }
			}
			anim = requestAnimationFrame(tick)
		}
		var host = el.closest("[data-shape-host]") || el
		host.addEventListener("pointerenter", function () { go(active, Math.PI / 3) })
		host.addEventListener("pointerleave", function () { go(rest, -Math.PI / 3) })
		host.addEventListener("focusin", function () { go(active, Math.PI / 3) })
		host.addEventListener("focusout", function () { go(rest, -Math.PI / 3) })
	}

	/* 3. Wavy lines: dividers and the loading bar. Drawn one wavelength wider
	      than the box and slid left by one wavelength, so the loop is seamless. */
	function wave(el) {
		var wavelength = Number(el.getAttribute("data-wavelength") || 36)
		var amplitude = Number(el.getAttribute("data-amplitude") || 5)
		var stroke = Number(el.getAttribute("data-stroke") || 3)
		var height = amplitude * 2 + stroke * 2 + 2
		var svg = document.createElementNS(SVGNS, "svg")
		svg.setAttribute("aria-hidden", "true")
		svg.setAttribute("class", "wave-svg")
		svg.setAttribute("height", String(height))
		svg.style.setProperty("--wave-shift", -wavelength + "px")
		var path = document.createElementNS(SVGNS, "path")
		svg.appendChild(path)
		el.appendChild(svg)
		function draw() {
			var width = Math.max(10, el.getBoundingClientRect().width)
			svg.setAttribute("width", String(width + wavelength))
			svg.setAttribute("viewBox", "0 0 " + (width + wavelength) + " " + height)
			var mid = height / 2
			var d = "M0 " + mid
			for (var x = 0; x <= width + wavelength; x += 2) {
				d += "L" + x + " " + (mid + Math.sin((x / wavelength) * TAU) * (reduce ? 0 : amplitude)).toFixed(2)
			}
			path.setAttribute("d", d)
			path.setAttribute("stroke-width", String(stroke))
		}
		draw()
		if ("ResizeObserver" in window) new ResizeObserver(draw).observe(el)
	}

	function init() {
		var i
		var loops = document.querySelectorAll("[data-morph]")
		for (i = 0; i < loops.length; i++) loopMorph(loops[i])
		var shapes = document.querySelectorAll("[data-shape]")
		for (i = 0; i < shapes.length; i++) hoverShape(shapes[i])
		var waves = document.querySelectorAll("[data-wave]")
		for (i = 0; i < waves.length; i++) wave(waves[i])
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init)
	else init()
})()
