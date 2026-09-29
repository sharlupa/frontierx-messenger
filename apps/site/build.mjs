// Assembles the static landing site: every page in pages/ gets the shared
// head, header and footer from partials/, and the result goes to dist/ (the
// directory served from SITE_DIR). Run with `node apps/site/build.mjs`.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))
const dist = join(root, "dist")
const partial = (name) => readFileSync(join(root, "partials", name + ".html"), "utf8")

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

for (const file of readdirSync(join(root, "pages"))) {
	if (!file.endsWith(".html")) continue
	const source = readFileSync(join(root, "pages", file), "utf8")
	// First line of each page: <!-- page: key | title-i18n-key | Russian title | description -->
	const meta = /^<!--\s*page:\s*(\w+)\s*\|\s*([\w.]+)\s*\|\s*([^|]+)\|\s*([^>]+?)\s*-->\n/.exec(source)
	if (!meta) throw new Error(file + ": missing page header comment")
	const [, key, titleKey, title, description] = meta
	let html = partial("layout")
		.replace("{{head}}", partial("head"))
		.replace("{{sprite}}", partial("sprite"))
		.replace("{{header}}", partial("header"))
		.replace("{{footer}}", partial("footer"))
		.replace("{{main}}", source.slice(meta[0].length))
		.replaceAll("{{page}}", key)
		.replaceAll("{{titleKey}}", titleKey)
		.replaceAll("{{title}}", title.trim())
		.replaceAll("{{description}}", description.trim())
	// Mark the current section in the navigation.
	html = html.replace(new RegExp(`data-nav="${key}"`, "g"), `data-nav="${key}" aria-current="page"`)
	writeFileSync(join(dist, file), html)
}
// Assets sit next to the pages: the server maps /site/<file> to SITE_DIR/<file>.
cpSync(join(root, "assets"), dist, { recursive: true })
console.log("site built into", dist)
