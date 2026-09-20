const { spawn, exec, execFileSync } = require("child_process")
const path = require("path")
const fs = require("fs")
const archiver = require("archiver")

function quoteIfNeeded(arg) {
	if (/[\s()]/.test(arg) && !/^".*"$/.test(arg)) {
		return `"${arg}"`
	}
	return arg
}

// Purely informational — the pipeline itself never needs to know this name
// (git pull/push already act on whichever branch is checked out), but the
// Settings screen shows it so the user can confirm which branch this machine
// is actually on.
function getCurrentBranch(repoPath) {
	try {
		const out = execFileSync("git", ["branch", "--show-current"], { cwd: repoPath, encoding: "utf8" })
		return out.trim() || null
	} catch {
		return null
	}
}

// Tracks whichever child process a running pipeline is currently waiting on, so
// the Stop button has something to kill. Commands run with shell:true, so the
// tracked pid is the shell (cmd.exe), not the real tool underneath it — on
// Windows only `taskkill /T` (kill the whole process tree) actually reaches it;
// child.kill() alone would leave git/dotnet/yarn/7z running detached.
let activeChild = null

function killActiveProcess() {
	if (!activeChild) return false
	activeChild.userCancelled = true
	if (process.platform === "win32") {
		exec(`taskkill /pid ${activeChild.pid} /T /F`)
	} else {
		activeChild.kill("SIGTERM")
	}
	return true
}

// These CLIs report no percentage of their own, so progress is derived from
// milestones that actually appear in their output. Percentages only ever move
// forward, and the caller snaps the bar to its final value when a step resolves.
function makeMilestoneScanner(milestones, onProgress) {
	let highest = null
	return text => {
		if (!onProgress) return
		for (const { re, percent } of milestones) {
			if ((highest === null || percent > highest) && re.test(text)) {
				highest = percent
			}
		}
		if (highest !== null) onProgress(highest)
	}
}

// rawScanner gets every chunk of output as-is, for tools like 7-Zip that do
// print a real percentage and so need no milestone guessing.
function runCommand(command, args, cwd, onLine, milestones, onProgress, rawScanner) {
	return new Promise((resolve, reject) => {
		onLine(`\n$ ${command} ${args.join(" ")}   (cwd: ${cwd})\n`)
		const quotedArgs = args.map(quoteIfNeeded)
		const child = spawn(quoteIfNeeded(command), quotedArgs, { cwd, shell: true })
		activeChild = child
		const scan = makeMilestoneScanner(milestones || [], onProgress)

		const handle = data => {
			const text = data.toString()
			onLine(text)
			scan(text)
			if (rawScanner) rawScanner(text)
		}

		child.stdout.on("data", handle)
		child.stderr.on("data", handle)

		child.on("error", err => {
			if (activeChild === child) activeChild = null
			reject(err)
		})
		child.on("close", code => {
			if (activeChild === child) activeChild = null
			if (child.userCancelled) reject(new Error("Cancelled by user"))
			else if (code === 0) resolve()
			else reject(new Error(`"${command} ${args.join(" ")}" exited with code ${code}`))
		})
	})
}

// The repo stays checked out on whatever branch the developer is working on (e.g.
// "dev_aminul") — this never switches branches. It only makes sure the deployed
// code is up to date: the patch step edits tracked files in place without
// committing, so by the next run there are uncommitted local changes that could
// make a merge fail; "git reset --hard" discards those first. Then "git pull
// origin <branch>" merges the actual deploy branch (main/master, from
// project.branches) into the current branch, same as running it by hand.
//
// Merging main/master into a personal branch like this creates local-only merge
// commits that origin/<current branch> never has, so the branch keeps drifting
// further "ahead" every run (VS Code's "Sync Changes" counter) even though the
// file content is already correct. Pushing "HEAD" (whatever branch is currently
// checked out, by name) keeps that counter from accumulating. Best-effort: a push
// failure (no permission, network, diverged remote, etc.) is logged but must not
// block the rest of the deploy.
function gitPull(repoPath, branch, onLine, onProgress) {
	return runCommand("git", ["reset", "--hard"], repoPath, onLine, null, null)
		.then(() =>
			runCommand(
				"git",
				["pull", "origin", branch],
				repoPath,
				onLine,
				[
					{ re: /remote:|Receiving objects|Unpacking/i, percent: 40 },
					{ re: /Resolving deltas|Fast-forward|files? changed|Already up to date/i, percent: 80 },
				],
				onProgress
			)
		)
		.then(() =>
			runCommand("git", ["push", "origin", "HEAD"], repoPath, onLine, null, null).catch(err => {
				onLine(`\n[WARN] Could not push local branch back to origin — ${err.message}\n`)
			})
		)
}

const YARN_BUILD_MILESTONES = [
	{ re: /Creating an optimized production build/i, percent: 15 },
	{ re: /Compiled successfully|Compiled with warnings|Treating warnings/i, percent: 75 },
	{ re: /File sizes after gzip/i, percent: 90 },
]

function yarnBuild(reactRepoPath, onLine, onProgress) {
	return runCommand("yarn", ["build"], reactRepoPath, onLine, YARN_BUILD_MILESTONES, onProgress)
}

const DOTNET_PUBLISH_MILESTONES = [
	{ re: /Determining projects to restore/i, percent: 8 },
	{ re: /Restored |up-to-date for restore/i, percent: 18 },
	{ re: /DCC\.Domain ->/i, percent: 32 },
	{ re: /DCC\.Application ->/i, percent: 46 },
	{ re: /DCC\.Infrastructure ->/i, percent: 62 },
	{ re: /DCC\.Web ->/i, percent: 80 },
]

// runtimeIdentifier: "" for a normal framework-dependent build (Windows/local),
// or e.g. "linux-x64" for the self-contained Linux build the live server runs.
function dotnetPublish(apiRepoPath, csprojRelative, outputDir, runtimeIdentifier, onLine, onProgress) {
	const csprojPath = path.join(apiRepoPath, csprojRelative)
	const args = ["publish", csprojPath, "-c", "Release", "-f", "net8.0"]

	if (runtimeIdentifier) {
		args.push("-r", runtimeIdentifier, "--self-contained", "true")
	}

	args.push("-o", outputDir)

	// NOTE: this builds into the project's own bin/obj folders. If Visual Studio
	// or IIS Express is currently running/debugging this same project, the DLLs
	// will be locked and this step will fail with MSB3027 — stop that debug
	// session before running Build here.
	return runCommand("dotnet", args, apiRepoPath, onLine, DOTNET_PUBLISH_MILESTONES, onProgress)
}

// .NET keeps MSBuild/Roslyn build servers alive for ~15 minutes after a publish,
// holding on to a couple of GB. The React build that runs next asks for an 8 GB
// heap plus terser worker threads, so on a 16 GB machine that leftover is enough
// to push it into an out-of-memory crash (jest-worker dies with a DOMException
// rather than a readable error). Best-effort: a failure here must not fail the
// deploy, it only means less memory was reclaimed.
function shutdownDotnetBuildServers(repoPath, onLine) {
	return runCommand("dotnet", ["build-server", "shutdown"], repoPath, onLine, null, null).catch(err => {
		onLine(`\n[WARN] Could not shut down dotnet build servers — ${err.message}\n`)
	})
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const APP_OFFLINE = "app_offline.htm"

// Dropping app_offline.htm makes the ASP.NET Core Module shut the app down and
// release its DLL handles — the same trick Visual Studio's web publish uses.
// Without it, publishing over a folder IIS is serving fails with EPERM/EBUSY.
function takeAppOffline(appDir, onLine) {
	fs.mkdirSync(appDir, { recursive: true })
	fs.writeFileSync(
		path.join(appDir, APP_OFFLINE),
		"<html><body><h1>Deploying…</h1></body></html>",
		"utf8"
	)
	onLine(`\nPlaced ${APP_OFFLINE} in ${appDir} (asking IIS to release the app)\n`)
}

function bringAppOnline(appDir, onLine) {
	const p = path.join(appDir, APP_OFFLINE)
	if (fs.existsSync(p)) {
		fs.rmSync(p, { force: true })
		onLine(`\nRemoved ${APP_OFFLINE} — app can start again\n`)
	}
}

// dotnet publish and the React copy both overwrite files but leave stale ones
// behind, so a publish target has to be emptied first. Guarded, because a typo
// in a configured path would otherwise delete the wrong tree. Retries because
// IIS does not drop its file handles the instant app_offline.htm appears.
async function clearDirContents(dir, forbiddenPaths, onLine, keepNames) {
	const resolved = path.resolve(dir)
	const segments = resolved.split(/[\\/]/).filter(Boolean)
	const keep = new Set((keepNames || []).map(n => n.toLowerCase()))

	if (segments.length < 2) {
		throw new Error(`Refusing to clear "${resolved}" — too close to a drive root.`)
	}

	for (const forbidden of forbiddenPaths || []) {
		if (!forbidden) continue
		const f = path.resolve(forbidden)
		if (resolved === f || resolved.startsWith(f + path.sep) || f.startsWith(resolved + path.sep)) {
			throw new Error(`Refusing to clear "${resolved}" — it overlaps the source repo "${f}".`)
		}
	}

	if (!fs.existsSync(resolved)) {
		fs.mkdirSync(resolved, { recursive: true })
		onLine(`\nCreated ${resolved}\n`)
		return
	}

	const entries = fs.readdirSync(resolved).filter(e => !keep.has(e.toLowerCase()))
	let removed = 0

	for (const entry of entries) {
		const target = path.join(resolved, entry)
		let lastErr = null

		// IIS takes a few seconds to shut the app down and drop its handles after
		// app_offline.htm appears (measured ~4s here), so back off and retry rather
		// than sleeping blindly on every run. Total patience ≈ 20s.
		for (let attempt = 1; attempt <= 8; attempt++) {
			try {
				fs.rmSync(target, { recursive: true, force: true })
				lastErr = null
				break
			} catch (err) {
				lastErr = err
				if (err.code !== "EPERM" && err.code !== "EBUSY" && err.code !== "ENOTEMPTY") throw err
				if (attempt === 1) onLine(`\nWaiting for the app to release ${entry}…\n`)
				await sleep(attempt * 700)
			}
		}

		if (lastErr) {
			throw new Error(
				`Could not delete "${target}" — it is still locked by another process ` +
					`(usually IIS/w3wp serving this folder, or a running dotnet process). ` +
					`Stop the site/app pool using this folder and run again. [${lastErr.code}]`
			)
		}
		removed++
	}

	onLine(`\nCleared ${removed} existing item(s) from ${resolved}\n`)
}

// Archives specific subfolders with 7-Zip, matching the existing manual workflow
// (a .7z sitting next to the api/ and react/ folders it contains). Only the named
// folders are added, so nothing else in that directory is swept in.
function sevenZipArchive(sevenZipExe, workingDir, archiveName, folders, onLine, onProgress) {
	if (!fs.existsSync(sevenZipExe)) {
		return Promise.reject(new Error(`7-Zip not found at "${sevenZipExe}". Fix paths.sevenZipExe in Settings.`))
	}

	const archivePath = path.join(workingDir, archiveName)
	// "7z a" appends to an existing archive, so a stale one must go first —
	// otherwise files deleted since the last run would linger inside it.
	if (fs.existsSync(archivePath)) {
		fs.rmSync(archivePath, { force: true })
		onLine(`\nRemoved previous archive ${archivePath}\n`)
	}

	// -bsp1 routes 7-Zip's percentage indicator to stdout so it can drive the bar.
	return runCommand(
		sevenZipExe,
		["a", archiveName, ...folders, "-bsp1"],
		workingDir,
		onLine,
		null,
		null,
		text => {
			if (!onProgress) return
			const matches = text.match(/(\d+)%/g)
			if (matches && matches.length) {
				const last = parseInt(matches[matches.length - 1], 10)
				if (!Number.isNaN(last)) onProgress(Math.min(99, last))
			}
		}
	).then(() => archivePath)
}

function zipFolder(sourceDir, zipFilePath, onLine, onProgress) {
	return new Promise((resolve, reject) => {
		fs.mkdirSync(path.dirname(zipFilePath), { recursive: true })
		const output = fs.createWriteStream(zipFilePath)
		const archive = archiver("zip", { zlib: { level: 9 } })

		output.on("close", () => {
			onLine(`\nZipped ${archive.pointer()} bytes -> ${zipFilePath}\n`)
			resolve(zipFilePath)
		})
		archive.on("warning", err => onLine(`\n[zip warning] ${err.message}\n`))
		archive.on("error", err => reject(err))

		// archiver reports real byte counts, so this bar is genuine progress.
		archive.on("progress", data => {
			if (!onProgress) return
			const total = data.fs.totalBytes
			const done = data.fs.processedBytes
			if (total > 0) onProgress(Math.min(95, Math.round((done / total) * 100)))
		})

		archive.pipe(output)
		archive.directory(sourceDir, false)
		archive.finalize()
	})
}

module.exports = {
	runCommand,
	killActiveProcess,
	getCurrentBranch,
	gitPull,
	yarnBuild,
	dotnetPublish,
	shutdownDotnetBuildServers,
	clearDirContents,
	takeAppOffline,
	bringAppOnline,
	APP_OFFLINE,
	sevenZipArchive,
	zipFolder,
	// exported for tests
	makeMilestoneScanner,
	DOTNET_PUBLISH_MILESTONES,
	YARN_BUILD_MILESTONES,
}
