const { app, BrowserWindow, ipcMain, Menu, shell } = require("electron")
const path = require("path")
const fs = require("fs")

const { applyPatchRules } = require("./src/patcher")
const {
	gitPull,
	yarnBuild,
	dotnetPublish,
	shutdownDotnetBuildServers,
	zipFolder,
	sevenZipArchive,
	clearDirContents,
	takeAppOffline,
	bringAppOnline,
	APP_OFFLINE,
	killActiveProcess,
	getCurrentBranch,
} = require("./src/runner")
const { stopIis, startIis } = require("./src/iis")
const { findFolders } = require("./src/pathDetector")

const bundledConfigPath = path.join(__dirname, "config", "environments.json")

// Packaged apps ship inside a read-only asar archive, so writable config
// lives in userData instead; dev mode (npm start) uses the repo copy directly.
const configPath = app.isPackaged
	? path.join(app.getPath("userData"), "environments.json")
	: bundledConfigPath

function ensureConfigExists() {
	if (!app.isPackaged) return

	if (!fs.existsSync(configPath)) {
		fs.mkdirSync(path.dirname(configPath), { recursive: true })
		fs.copyFileSync(bundledConfigPath, configPath)
		return
	}

	// A previously installed version left its own copy in userData, which would
	// otherwise shadow preset changes shipped in a newer build (e.g. a removed or
	// relabelled environment). Bumping configVersion in the bundled file replaces it.
	try {
		const bundled = JSON.parse(fs.readFileSync(bundledConfigPath, "utf8"))
		const existing = JSON.parse(fs.readFileSync(configPath, "utf8"))
		if ((bundled.configVersion || 0) > (existing.configVersion || 0)) {
			fs.copyFileSync(bundledConfigPath, configPath)
		}
	} catch {
		// A corrupt user config should not brick the app — fall back to the bundled one.
		fs.copyFileSync(bundledConfigPath, configPath)
	}
}

function loadConfig() {
	ensureConfigExists()
	return JSON.parse(fs.readFileSync(configPath, "utf8"))
}

function saveConfig(cfg) {
	ensureConfigExists()
	fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8")
}

let mainWindow

function createWindow() {
	// No File/Edit/View menu — nothing in it applies to this tool.
	Menu.setApplicationMenu(null)

	mainWindow = new BrowserWindow({
		width: 980,
		height: 760,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
		},
	})
	mainWindow.loadFile("index.html")

	// One-time, on the very first launch only (tracked in the saved config so it
	// never repeats): fill in any repo path that doesn't exist on this machine.
	// Runs after the page loads so sendLog/the result event actually reach it.
	mainWindow.webContents.once("did-finish-load", () => {
		const cfg = loadConfig()
		if (cfg.autoDetectDone) return
		cfg.autoDetectDone = true
		saveConfig(cfg)

		const { changed, results } = detectAndFillMissingPaths(cfg, sendLog)
		if (changed) saveConfig(cfg)
		if (results.length > 0) {
			mainWindow.webContents.send("auto-detect-done", results)
		}
	})
}

app.whenReady().then(createWindow)
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit()
})

function sendLog(line) {
	if (mainWindow) mainWindow.webContents.send("log", line)
}

function sendStep(step, status) {
	if (mainWindow) mainWindow.webContents.send("step", { step, status })
}

function sendProgress(step, percent) {
	if (mainWindow) mainWindow.webContents.send("progress", { step, percent: Math.round(percent) })
}

// Maps a sub-task's own 0-100 progress onto a slice of the parent step's bar,
// e.g. the API pull filling 0-50% and the React pull filling 50-100%.
function slice(step, from, to) {
	return percent => sendProgress(step, from + (percent / 100) * (to - from))
}

ipcMain.handle("get-config", () => loadConfig())
ipcMain.handle("save-config", (_evt, cfg) => {
	saveConfig(cfg)
	return true
})

// Scans every drive for repo folders whose currently configured path does not
// exist on this machine (a fresh install elsewhere, a drive letter that
// changed, etc.) and fills in whatever it finds by exact folder-name match. A
// path that already resolves is left untouched, even if a same-named folder
// turns up elsewhere — that would just be a stray/backup copy, not the one to
// build from.
function detectAndFillMissingPaths(cfg, onLine) {
	const missing = []
	for (const [projKey, project] of Object.entries(cfg.projects)) {
		for (const [repoId, repoPath] of Object.entries(project.repos)) {
			if (!fs.existsSync(repoPath)) {
				missing.push({ projKey, repoId, repoPath, folderName: path.basename(repoPath) })
			}
		}
	}
	if (missing.length === 0) return { changed: false, results: [] }

	const found = findFolders(
		missing.map(m => m.folderName),
		onLine
	)

	const results = missing.map(m => {
		const foundPath = found[m.folderName]
		if (foundPath) cfg.projects[m.projKey].repos[m.repoId] = foundPath
		return { ...m, foundPath: foundPath || null }
	})

	return { changed: results.some(r => r.foundPath), results }
}

ipcMain.handle("get-current-branches", () => {
	const cfg = loadConfig()
	const result = {}
	for (const [projKey, project] of Object.entries(cfg.projects)) {
		for (const [repoId, repoPath] of Object.entries(project.repos)) {
			result[`${projKey}.${repoId}`] = fs.existsSync(repoPath) ? getCurrentBranch(repoPath) : null
		}
	}
	return result
})

ipcMain.handle("detect-paths", () => {
	const cfg = loadConfig()
	const { changed, results } = detectAndFillMissingPaths(cfg, sendLog)
	if (changed) saveConfig(cfg)
	return results
})

ipcMain.handle("cancel-pipeline", () => killActiveProcess())

ipcMain.handle("open-folder", (_evt, folderPath) => shell.openPath(folderPath))

ipcMain.handle("run-pipeline", async (_evt, { projectKey, envKey, variantKey, steps }) => {
	const cfg = loadConfig()
	const project = cfg.projects[projectKey]
	if (!project) throw new Error(`Unknown project: ${projectKey}`)

	const baseEnv = project.environments[envKey]
	if (!baseEnv) throw new Error(`Unknown environment: ${envKey}`)

	// Some environments (e.g. Global's per-client presets) offer more than one
	// connection-string/API-URL pairing — Test vs. Live, or a couple of Live
	// candidates that were never fully reconciled. "variants" holds those; the
	// chosen one's values/runtimeIdentifier override the environment's own.
	let env = baseEnv
	if (baseEnv.variants) {
		const variant = baseEnv.variants[variantKey]
		if (!variant) throw new Error(`Environment "${envKey}" has no variant "${variantKey}"`)
		env = {
			...baseEnv,
			label: `${baseEnv.label} — ${variant.label}`,
			runtimeIdentifier: variant.runtimeIdentifier !== undefined ? variant.runtimeIdentifier : baseEnv.runtimeIdentifier,
			values: variant.values,
		}
	}

	const tools = cfg.tools
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-")

	// An environment with a publishDir writes straight into that fixed folder
	// (wiping stale files first) instead of a timestamped run folder. An empty
	// archiveName means the archive step is skipped — local dev wants the loose
	// files, not an archive it would just have to unpack again.
	const publishDir = (env.publishDir || "").trim()
	const usesPublishDir = publishDir !== ""
	const archiveName = (env.archiveName || "").trim()
	const runtimeIdentifier = (env.runtimeIdentifier || "").trim()

	const iisSiteName = (env.iisSiteName || "").trim()
	const iisAppPool = (env.iisAppPool || "").trim()
	const managesIis = usesPublishDir && (iisSiteName !== "" || iisAppPool !== "")

	const runDir = usesPublishDir ? publishDir : path.join(tools.outputRoot, timestamp)

	const repoPath = id => {
		const p = project.repos[id]
		if (!p) throw new Error(`Project "${projectKey}" has no repo "${id}"`)
		return p
	}
	const repoBranch = id => {
		const b = (project.branches || {})[id]
		if (!b) throw new Error(`Project "${projectKey}" has no branch configured for repo "${id}"`)
		return b
	}
	const repoIds = Object.keys(project.repos)
	const allRepos = Object.values(project.repos)
	const artifacts = project.artifacts
	const outDirOf = a => path.join(runDir, a.folder)
	// The API artifact is the one IIS serves, so it is where app_offline.htm goes.
	const apiArtifact = artifacts.find(a => a.type === "dotnet")

	// Remembers what this run actually stopped, so the restore only starts back
	// up what it took down.
	let iisStopped = null

	const restoreApp = async () => {
		if (!usesPublishDir) return
		if (managesIis) {
			await startIis(tools.appcmdExe, iisSiteName, iisAppPool, iisStopped, sendLog)
			iisStopped = null
		} else if (apiArtifact) {
			bringAppOnline(outDirOf(apiArtifact), sendLog)
		}
	}

	try {
		if (steps.gitPull) {
			sendStep("gitPull", "running")
			sendProgress("gitPull", 0)
			const share = 100 / repoIds.length
			for (let i = 0; i < repoIds.length; i++) {
				await gitPull(
					allRepos[i],
					repoBranch(repoIds[i]),
					sendLog,
					slice("gitPull", i * share, (i + 1) * share)
				)
				sendProgress("gitPull", (i + 1) * share)
			}
			sendStep("gitPull", "done")
		}

		if (steps.patch) {
			sendStep("patch", "running")
			sendProgress("patch", 0)
			sendLog(`\nPatching ${project.label} for "${env.label}"\n`)

			const rules = project.patchRules.map(r => ({
				...r,
				file: path.join(repoPath(r.repo), r.file),
			}))
			applyPatchRules(rules, env.values, sendLog)

			sendProgress("patch", 100)
			sendStep("patch", "done")
		}

		if (steps.build) {
			sendStep("build", "running")
			sendProgress("build", 0)

			if (usesPublishDir) {
				// Whatever is serving these folders has to let go of the DLLs first.
				// Stopping the app pool kills the worker holding the handles; without
				// an IIS site configured, app_offline.htm is the fallback.
				if (managesIis) {
					iisStopped = await stopIis(tools.appcmdExe, iisSiteName, iisAppPool, sendLog)
				} else if (apiArtifact) {
					takeAppOffline(outDirOf(apiArtifact), sendLog)
				}

				// Clear the whole publish folder first — not just the artifact
				// subfolders — so anything stray left over at the top level (an old
				// manual copy, a leftover archive-extraction folder, etc.) never
				// survives into a fresh build. The artifact folders themselves are
				// kept here (not wiped wholesale) so the per-folder pass below can
				// still preserve the app_offline marker while IIS is down.
				const artifactFolderNames = artifacts.map(a => a.folder)
				await clearDirContents(runDir, allRepos, sendLog, artifactFolderNames)

				// No fixed wait here — clearDirContents backs off and retries only if
				// something is actually still holding a file.
				for (const a of artifacts) {
					const keep = !managesIis && a === apiArtifact ? [APP_OFFLINE] : []
					await clearDirContents(outDirOf(a), allRepos, sendLog, keep)
				}
			}

			// Each artifact gets an equal slice of the bar.
			const share = 100 / artifacts.length
			for (let i = 0; i < artifacts.length; i++) {
				const a = artifacts[i]
				const from = i * share
				const to = (i + 1) * share
				const outDir = outDirOf(a)

				if (a.type === "dotnet") {
					if (runtimeIdentifier) {
						sendLog(`\nPublishing ${a.id} self-contained for ${runtimeIdentifier}\n`)
					}
					await dotnetPublish(
						repoPath(a.repo),
						a.csproj,
						outDir,
						runtimeIdentifier,
						sendLog,
						slice("build", from, to)
					)
					// Hand the memory back before the React build starts — see
					// shutdownDotnetBuildServers for why that matters here.
					await shutdownDotnetBuildServers(repoPath(a.repo), sendLog)
				} else if (a.type === "yarn") {
					await yarnBuild(repoPath(a.repo), sendLog, slice("build", from, to - share * 0.1))
					const built = path.join(repoPath(a.repo), a.buildDir || "build")
					if (!fs.existsSync(built)) {
						throw new Error(`Build output not found for "${a.id}": ${built}`)
					}
					fs.mkdirSync(outDir, { recursive: true })
					fs.cpSync(built, outDir, { recursive: true })
					sendLog(`\nCopied ${a.id} build -> ${outDir}\n`)
				} else {
					throw new Error(`Unknown artifact type "${a.type}" for "${a.id}"`)
				}

				sendProgress("build", to)
			}

			// Publish finished — let the app serve again. Removing the marker also
			// keeps it out of the archive, so a deployed copy never starts offline.
			await restoreApp()

			sendProgress("build", 100)
			sendStep("build", "done")
		}

		if (steps.zip && archiveName) {
			sendStep("zip", "running")
			sendProgress("zip", 0)

			let archivePath
			if (usesPublishDir) {
				// Only the artifact folders are archived, so a previous archive
				// sitting in the same folder is never packed into the new one.
				archivePath = await sevenZipArchive(
					tools.sevenZipExe,
					runDir,
					archiveName,
					artifacts.map(a => a.folder),
					sendLog,
					p => sendProgress("zip", p)
				)
			} else {
				archivePath = path.join(tools.outputRoot, archiveName)
				await zipFolder(runDir, archivePath, sendLog, p => sendProgress("zip", p))
			}

			sendProgress("zip", 100)
			sendStep("zip", "done")
			return { runDir, zipPath: archivePath }
		}

		if (steps.zip && !archiveName) {
			sendLog(`\nNo archive for "${env.label}" — files published directly to ${runDir}\n`)
			sendStep("zip", "skipped")
		}

		return { runDir }
	} catch (err) {
		// Never leave the site stuck down because a build failed halfway.
		try {
			await restoreApp()
		} catch (cleanupErr) {
			sendLog(`\n[WARN] could not bring the app back up: ${cleanupErr.message}\n`)
		}
		sendLog(`\n[ERROR] ${err.message}\n`)
		sendStep("error", err.message)
		throw err
	}
})
