const fs = require("fs")
const path = require("path")

// Directories that are either huge, irrelevant, or both — descending into them
// wastes the whole time budget without ever finding a repo folder.
const SKIP_DIRS = new Set([
	"node_modules",
	"$recycle.bin",
	"system volume information",
	"windows",
	"program files",
	"program files (x86)",
	"programdata",
	"appdata",
	".git",
	"$windows.~bt",
	"$windows.~ws",
	"recovery",
])

function listDrives() {
	const drives = []
	for (let c = 65; c <= 90; c++) {
		const root = `${String.fromCharCode(c)}:\\`
		try {
			if (fs.existsSync(root)) drives.push(root)
		} catch {
			// inaccessible drive (e.g. an empty card reader) — skip it
		}
	}
	return drives
}

// Bounded depth-first search across every drive for folders whose name exactly
// matches one of targetNames. Stops as soon as every name has been found, and
// gives up on the whole scan past a time budget so one huge/slow disk can't
// hang the app indefinitely. A matched folder is not descended into further —
// these are project repo roots, nothing relevant lives one level up from a
// same-named collision.
function findFolders(targetNames, onLine, options = {}) {
	const maxDepth = options.maxDepth ?? 8
	const budgetMs = options.budgetMs ?? 45000
	const remaining = new Set(targetNames)
	const found = {}
	const deadline = Date.now() + budgetMs

	function walk(dir, depth) {
		if (remaining.size === 0 || Date.now() > deadline || depth > maxDepth) return

		let entries
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return // permission denied, junction loop, etc.
		}

		for (const entry of entries) {
			if (remaining.size === 0 || Date.now() > deadline) return
			if (!entry.isDirectory()) continue
			if (SKIP_DIRS.has(entry.name.toLowerCase())) continue

			const full = path.join(dir, entry.name)

			if (remaining.has(entry.name)) {
				found[entry.name] = full
				remaining.delete(entry.name)
				continue
			}

			walk(full, depth + 1)
		}
	}

	for (const drive of listDrives()) {
		if (remaining.size === 0 || Date.now() > deadline) break
		if (onLine) onLine(`Scanning ${drive} for ${remaining.size} folder(s)...\n`)
		walk(drive, 0)
	}

	return found
}

module.exports = { findFolders, listDrives }
