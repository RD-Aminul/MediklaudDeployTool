const fs = require("fs")
const path = require("path")
const { buildRegex } = require("./patcher")
const { getCurrentBranch } = require("./runner")

// Quick Setup: given just a repo folder, work out what the Project Setup
// tables would otherwise need typed by hand — the branch, the .csproj or build
// folder, and which file/key holds the connection string or API URL — so
// someone who doesn't know the codebase can set up a project with two clicks.

const SKIP_DIRS = new Set(["node_modules", ".git", "bin", "obj", "build", "dist", "wwwroot", ".vs", ".vscode", "packages", "Migrations", "public"])

// Relative paths of files under root whose extension is in exts, no deeper
// than maxDepth folders, capped so a huge repo can't stall the UI.
function listFiles(root, exts, maxDepth, limit = 4000) {
	const out = []
	const walk = (dir, depth) => {
		if (out.length >= limit) return
		let entries
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const e of entries) {
			if (out.length >= limit) return
			const full = path.join(dir, e.name)
			if (e.isDirectory()) {
				if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(full, depth + 1)
			} else if (exts.includes(path.extname(e.name).toLowerCase())) {
				out.push(path.relative(root, full))
			}
		}
	}
	walk(root, 0)
	return out
}

function readLines(file) {
	try {
		return fs.readFileSync(file, "utf8").split(/\r\n|\n/)
	} catch {
		return []
	}
}

// How many lines of the file the patcher would actually recognise for this
// key — a suggestion the patch step can't act on is worse than none.
function patchableLines(lines, kind, name) {
	const re = buildRegex(kind, name)
	return lines.filter(l => re.test(l)).length
}

/* ---------------- API (dotnet) ---------------- */

// The web project is the one next to an appsettings.json/Program.cs and using
// the Web SDK; class libraries and test projects score lower.
function pickCsproj(root) {
	const candidates = listFiles(root, [".csproj"], 3).map(rel => {
		const dir = path.join(root, path.dirname(rel))
		let text = ""
		try {
			text = fs.readFileSync(path.join(root, rel), "utf8")
		} catch {}
		let score = 0
		if (/Sdk="Microsoft\.NET\.Sdk\.Web"/i.test(text)) score += 3
		if (fs.existsSync(path.join(dir, "appsettings.json"))) score += 2
		if (fs.existsSync(path.join(dir, "Program.cs"))) score += 1
		if (/test/i.test(rel)) score -= 4
		return { rel, score }
	})
	candidates.sort((a, b) => b.score - a.score)
	return candidates[0] ? candidates[0].rel : null
}

// Every key inside appsettings.json's "ConnectionStrings" block, including
// ones that are only present as commented-out alternatives.
function jsonConnectionRules(root, csproj) {
	const rel = path.join(path.dirname(csproj), "appsettings.json")
	const lines = readLines(path.join(root, rel))
	const names = []
	let inBlock = false
	for (const line of lines) {
		if (!inBlock) {
			if (/"ConnectionStrings"\s*:\s*\{/.test(line)) inBlock = true
			continue
		}
		if (/^\s*\}/.test(line)) break
		const m = line.match(/^\s*(?:\/\/\s*)?"(\w+)"\s*:\s*"/)
		if (m && !names.includes(m[1])) names.push(m[1])
	}
	return names
		.map(name => ({ file: rel, kind: "json", name, count: patchableLines(lines, "json", name) }))
		.filter(r => r.count > 0)
}

const CONN_VALUE = /(password|pwd)\s*=/i
const CONN_TARGET = /(user id|uid|data source|host|server)\s*=/i

// Hard-coded connection strings in C# (Global/Jail keep theirs in a
// MediklaudDBConnection.cs as `_connectionString = "...";`, one line per
// server with all but one commented out). Ranked by how many alternatives a
// key has — the real switchboard file has many, stray helpers have one.
function csConnectionRules(root) {
	const found = new Map()
	for (const rel of listFiles(root, [".cs"], 5)) {
		let content
		try {
			content = fs.readFileSync(path.join(root, rel), "utf8")
		} catch {
			continue
		}
		// Cheap checks first — the line regex backtracks badly on long lines,
		// and a big API has thousands of .cs files with no connection string.
		if (!CONN_VALUE.test(content)) continue
		const lines = content.split(/\r\n|\n/)
		for (const line of lines) {
			if (!CONN_VALUE.test(line) || line.length > 2000) continue
			// `<anything> name = "value";` — the name is the identifier right
			// before the first `= "`.
			const m = line.match(/^([^"]*)=\s*"([^"]*)"\s*;/)
			const id = m && m[1].match(/([A-Za-z_]\w*)\s*$/)
			if (!id || !CONN_VALUE.test(m[2]) || !CONN_TARGET.test(m[2])) continue
			const key = `${rel}|${id[1]}`
			if (!found.has(key)) found.set(key, { file: rel, kind: "cs", name: id[1], lines })
		}
	}
	return [...found.values()]
		.map(({ lines, ...r }) => ({ ...r, count: patchableLines(lines, "cs", r.name) }))
		.filter(r => r.count > 0)
		.sort((a, b) => b.count - a.count)
}

function analyzeApi(root) {
	const result = { branch: getCurrentBranch(root), csproj: pickCsproj(root), rules: [], warnings: [] }
	if (!result.csproj) {
		result.warnings.push("no .csproj found in the API folder")
		return result
	}
	const json = jsonConnectionRules(root, result.csproj)
	const cs = csConnectionRules(root)
	// Only the best C# file — several hits usually mean one real switchboard
	// plus leftovers (old helpers, samples) that were never used for deploys.
	result.rules = [...json, ...(cs.length ? cs.filter(r => r.file === cs[0].file) : [])]
	if (result.rules.length === 0) result.warnings.push("no connection string found in the API code")
	return result
}

/* ---------------- React ---------------- */

const URL_KEY = /url|api|base|host|server/i

// .env keys holding a URL. Alternatives are spelled NAME_Live, NAME_Test...,
// and only the plain active NAME is what the app reads, so that is the one
// to patch.
function envUrlRules(root) {
	const rel = ".env"
	const lines = readLines(path.join(root, rel))
	const active = []
	for (const line of lines) {
		const m = line.match(/^\s*((?:REACT_APP|VITE)_\w+)\s*=\s*["']?https?:\/\//)
		if (m && URL_KEY.test(m[1])) active.push(m[1])
	}
	return active
		.filter(n => !active.some(o => o !== n && n.startsWith(`${o}_`)))
		.map(name => ({
			file: rel,
			kind: "env",
			name,
			count: lines.filter(l => new RegExp(`^\\s*#?\\s*${name}(_\\w+)?\\s*=`).test(l)).length,
		}))
}

// baseURL: "http://...",  API_URL: '...',  export const API_BASE_URL = "...";
function sourceUrlRules(root) {
	const found = new Map()
	for (const rel of listFiles(path.join(root, "src"), [".js", ".jsx", ".ts", ".tsx"], 4).map(r => path.join("src", r))) {
		const lines = readLines(path.join(root, rel))
		if (!lines.some(l => l.includes("http"))) continue
		for (const line of lines) {
			if (!line.includes("http") || line.length > 2000) continue
			let m = line.match(/^\s*(?:\/\/\s*)?(\w+)\s*:\s*["']https?:\/\//)
			let kind = "js"
			if (!m) {
				m = line.match(/^\s*(?:\/\/\s*)?(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*"https?:\/\/[^"]*"\s*;/)
				kind = "cs"
			}
			if (!m || !URL_KEY.test(m[1])) continue
			const key = `${rel}|${m[1]}|${kind}`
			if (!found.has(key)) found.set(key, { file: rel, kind, name: m[1], lines })
		}
	}
	return [...found.values()]
		.map(({ lines, ...r }) => ({ ...r, count: patchableLines(lines, r.kind, r.name) }))
		.filter(r => r.count > 0)
		.sort((a, b) => b.count - a.count)
}

function analyzeReact(root) {
	let pkg = {}
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
	} catch {}
	const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
	const result = {
		branch: getCurrentBranch(root),
		buildDir: deps.vite ? "dist" : "build",
		rules: [],
		warnings: [],
	}
	if (!pkg.name && !pkg.scripts) result.warnings.push("no package.json in the React folder")

	// The API URL lives in exactly one place per app — prefer .env when the
	// app has one, otherwise the source line with the most alternatives.
	const env = envUrlRules(root)
	const src = sourceUrlRules(root)
	const best = env[0] || src[0]
	if (best) result.rules = [best]
	else result.warnings.push("no API URL found in .env or src")
	return result
}

// folders: [{ role: "api" | "react", path }]
function analyzeFolders(folders) {
	return folders.map(f => {
		if (!f.path || !fs.existsSync(f.path)) return { ...f, error: "folder not found" }
		const info = f.role === "api" ? analyzeApi(f.path) : analyzeReact(f.path)
		if (!fs.existsSync(path.join(f.path, ".git"))) info.warnings.push("not a git repository — Git Pull will fail")
		return { ...f, ...info }
	})
}

module.exports = { analyzeFolders }
