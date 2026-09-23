const fs = require("fs")

function splitLines(content) {
	const usesCRLF = content.includes("\r\n")
	const lines = content.split(/\r\n|\n/)
	return { lines, eol: usesCRLF ? "\r\n" : "\n" }
}

function escapeRegex(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// One regex shape per kind of config line these projects use. Every kind except
// "env" captures 5 groups — indent, comment marker, key+opening quote, value,
// trailing — which is what the comment/uncomment toggle below relies on.
function buildRegex(kind, name) {
	const n = escapeRegex(name)
	switch (kind) {
		// "DefaultConnection": "...",        (DCCI appsettings.json)
		case "json":
			return new RegExp(`^(\\s*)(\\/\\/\\s*)?("${n}"\\s*:\\s*")([^"]*)("\\s*,?.*)$`)
		// internal static readonly string PG_PACKAGE_NAME = "...";   (DCCI)
		// _connectionString = "...";                                 (Global, Jail)
		case "cs":
			return new RegExp(`^(\\s*)(\\/\\/\\s*)?([^"]*?\\b${n}\\s*=\\s*")([^"]*)("\\s*;.*)$`)
		// baseURL: "...",     (DCCI/Global api.js)
		// API_URL: "..."      (Jail VMS Variables.js)
		case "js":
			// Global's api.js mixes single and double quotes across lines, so accept
			// either — the value/rest capture excludes both quote chars, so each
			// line's own opening/closing quote is preserved verbatim on write-back.
			return new RegExp(`^(\\s*)(\\/\\/\\s*)?(${n}\\s*:\\s*["'])([^"']*)(["']\\s*,?.*)$`)
		default:
			throw new Error(`Unknown patch kind "${kind}"`)
	}
}

// Flips the file so the line holding targetValue becomes the active one and any
// other matching line is commented out — mirroring the manual comment/uncomment
// workflow used throughout these repos, instead of overwriting a value in place.
function toggleActiveLine(content, regex, targetValue, label) {
	const { lines, eol } = splitLines(content)
	const matches = []

	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(regex)
		if (m) {
			matches.push({
				index: i,
				indent: m[1],
				commentMarker: m[2] || "",
				keyPart: m[3],
				value: m[4],
				rest: m[5],
			})
		}
	}

	if (matches.length === 0) {
		throw new Error(`No "${label}" line found in this file at all.`)
	}

	const activeMatch = matches.find(m => m.commentMarker === "")
	const commentedSample = matches.find(m => m.commentMarker !== "")
	const commentStyle = commentedSample ? commentedSample.commentMarker : "//"
	const targetMatch = matches.find(m => m.value === targetValue)

	if (!targetMatch) {
		// No line carries this value — a brand-new preset value, or one whose only
		// copy was lost to an in-place overwrite. Comment out the current active
		// line (preserving it) and insert the target as a fresh active line.
		const template = activeMatch || commentedSample
		const cleanRest = template.rest.replace(/\/\/.*$/, "").replace(/\s+$/, "")
		const newLine = `${template.indent}${template.keyPart}${targetValue}${cleanRest}`

		if (activeMatch) {
			const m = activeMatch
			lines[m.index] = `${m.indent}${commentStyle}${m.keyPart}${m.value}${m.rest}`
			lines.splice(m.index + 1, 0, newLine)
		} else {
			lines.splice(matches[matches.length - 1].index + 1, 0, newLine)
		}
		return lines.join(eol)
	}

	if (activeMatch && activeMatch.index !== targetMatch.index) {
		const m = activeMatch
		lines[m.index] = `${m.indent}${commentStyle}${m.keyPart}${m.value}${m.rest}`
	}

	if (targetMatch.commentMarker !== "") {
		const m = targetMatch
		lines[m.index] = `${m.indent}${m.keyPart}${m.value}${m.rest}`
	}

	return lines.join(eol)
}

// .env files list alternatives as separate keys (REACT_APP_API_URL_Live etc.)
// rather than commented-out duplicates, so there is nothing to toggle — the
// value is simply replaced.
function setEnvValue(content, name, targetValue, label) {
	const { lines, eol } = splitLines(content)
	const re = new RegExp(`^(\\s*)(${escapeRegex(name)}\\s*=)(.*)$`)
	let found = false

	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(re)
		if (m) {
			lines[i] = `${m[1]}${m[2]}${targetValue}`
			found = true
			break
		}
	}

	if (!found) throw new Error(`No "${label}" entry found in this .env file.`)
	return lines.join(eol)
}

// rules: [{ file, kind, name, field }] — file is already absolute.
// values: { field: value } for the selected environment.
function applyPatchRules(rules, values, onLine) {
	for (const rule of rules) {
		const targetValue = values[rule.field]
		if (targetValue === undefined || targetValue === null || targetValue === "") {
			onLine(`   skipped ${rule.field} (no value for this environment)\n`)
			continue
		}

		if (!fs.existsSync(rule.file)) {
			throw new Error(`Patch target not found: ${rule.file}`)
		}

		let content = fs.readFileSync(rule.file, "utf8")
		const label = `${rule.name} (${rule.field})`

		if (rule.kind === "env") {
			content = setEnvValue(content, rule.name, targetValue, label)
		} else {
			content = toggleActiveLine(content, buildRegex(rule.kind, rule.name), targetValue, label)
		}

		fs.writeFileSync(rule.file, content, "utf8")
		onLine(`   ${rule.name} -> ${targetValue}\n`)
	}
}

// Reads every file a set of patch rules touches, before any of them are
// patched, so the working tree can be put back exactly as it was found once
// the build that needed the patched values is done. Keyed by absolute path
// since DCCI's rules, for instance, patch two different keys in one shared
// appsettings.json — that file must only be captured (and restored) once.
function snapshotFiles(rules) {
	const snapshot = new Map()
	for (const rule of rules) {
		if (!snapshot.has(rule.file) && fs.existsSync(rule.file)) {
			snapshot.set(rule.file, fs.readFileSync(rule.file, "utf8"))
		}
	}
	return snapshot
}

// Writes every captured file back to its pre-patch content. Best-effort per
// file — one unwritable file (e.g. locked by an editor) must not stop the
// others from being restored, and the caller (main.js) treats this as cleanup
// that should never itself fail the pipeline.
function restoreFiles(snapshot, onLine) {
	for (const [file, original] of snapshot) {
		try {
			fs.writeFileSync(file, original, "utf8")
			onLine(`\nRestored ${file} to its pre-patch content\n`)
		} catch (err) {
			onLine(`\n[WARN] could not restore ${file} — ${err.message}\n`)
		}
	}
}

/* ---------------- candidate scan (Settings tab pick list) ---------------- */

// A line that is (or is a commented-out copy of) some key/value config entry —
// any key, not just the one being scanned — so it is never mistaken for a
// section heading: `"X": "..."`, `baseURL: '...'`, `_connectionString = "..."`,
// `export const API_BASE_URL = "..."`, or a bare `.env` style `KEY=...`.
function looksLikeEntry(text) {
	return /^(?:[\w$]+\s+)*["']?[\w.$]+["']?\s*[:=]\s*["'`]/.test(text) || /^[A-Z][A-Z0-9_]*\s*=/.test(text)
}

function trailingComment(rest) {
	const m = (rest || "").match(/\/\/\s*(.*?)\s*$/)
	return m ? m[1] : ""
}

// The nearest heading comment above a candidate line — "02.BNHL",
// "LIVE SERVER · accounts.dhakachamber.com" — skipping sibling entries, blank
// lines and "=====" rules, and stopping at the previous section's "... End"
// marker or at real code, so a value is never labelled with a heading that
// belongs to a different block.
function sectionHeading(lines, index, entry) {
	const collected = []
	for (let j = index - 1; j >= 0 && j >= index - 15; j--) {
		const raw = lines[j].trim()
		if (raw === "") {
			if (collected.length) break
			continue
		}
		const isComment = /^(\/\/|\/\*|#|\*)/.test(raw)
		const text = isComment ? raw.replace(/^[/#*\s]+/, "").replace(/\*\/\s*$/, "").trim() : raw
		if (entry.test(lines[j]) || looksLikeEntry(text)) {
			if (collected.length) break
			continue
		}
		if (!isComment) break
		if (!text || /^[=\-_*~#.\s]+$/.test(text)) {
			if (collected.length) break
			continue
		}
		if (/\bend$/i.test(text)) break
		collected.unshift(text.replace(/\s+start$/i, ""))
		if (collected.length === 2) break
	}
	return collected.join(" · ")
}

// Every value a patch rule could switch its file to — each active or
// commented-out line holding the rule's key (for .env files, the key and its
// NAME_suffix alternatives) — with the line's trailing comment as a label and
// the nearest heading above it as a group. Lets the Settings tab offer a pick
// list instead of making someone retype a value character-for-character.
function scanCandidates(content, kind, name) {
	const { lines } = splitLines(content)
	const isEnv = kind === "env"
	const entry = isEnv
		? new RegExp(`^\\s*(#\\s*)?(${escapeRegex(name)}(?:_(\\w+))?)\\s*=\\s*(.*?)\\s*$`)
		: buildRegex(kind, name)

	const found = []
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(entry)
		if (!m) continue
		const value = m[4]
		if (!value) continue
		found.push({
			value,
			label: isEnv ? (m[3] ? m[3].replace(/_/g, " ") : "") : trailingComment(m[5]),
			active: isEnv ? !m[1] && !m[3] : !m[2],
			group: sectionHeading(lines, i, entry),
		})
	}
	return found
}

module.exports = {
	applyPatchRules,
	toggleActiveLine,
	setEnvValue,
	buildRegex,
	snapshotFiles,
	restoreFiles,
	scanCandidates,
}
