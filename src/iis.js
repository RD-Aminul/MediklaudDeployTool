const { execFile } = require("child_process")
const fs = require("fs")

// appcmd needs an elevated process. The app declares requireAdministrator so it
// is already elevated by the time these run; if that ever changes, appcmd fails
// reading redirection.config and the error below explains why.
function runAppcmd(appcmdExe, args) {
	return new Promise((resolve, reject) => {
		execFile(appcmdExe, args, { windowsHide: true }, (err, stdout, stderr) => {
			const output = `${stdout || ""}${stderr || ""}`.trim()
			if (err) {
				if (/insufficient permissions|redirection\.config/i.test(output)) {
					const e = new Error("IIS control needs administrator rights — run this app as Administrator.")
					e.adminRequired = true
					reject(e)
					return
				}
				const e = new Error(output || err.message)
				e.appcmdOutput = output
				reject(e)
				return
			}
			resolve(output)
		})
	})
}

async function getState(appcmdExe, kind, name) {
	try {
		const out = await runAppcmd(appcmdExe, ["list", kind, `/${kind}.name:${name}`, "/text:state"])
		return out.trim()
	} catch (err) {
		// runAppcmd already rewrites a permissions failure into a friendly message
		// that no longer contains "insufficient permissions" — checking the message
		// text here again silently swallowed that case as "not found". Check the
		// flag it sets instead.
		if (err.adminRequired) throw err
		return null // not found
	}
}

// Stopping the app pool is what actually releases the worker process's file
// handles; stopping the site as well keeps requests from arriving mid-publish.
// Only the named site/pool are touched, so other sites on this IIS stay up.
async function stopIis(appcmdExe, siteName, appPoolName, onLine) {
	if (!fs.existsSync(appcmdExe)) {
		throw new Error(`appcmd.exe not found at "${appcmdExe}". Fix paths.appcmdExe in Settings.`)
	}

	const stopped = { site: false, pool: false }

	if (siteName) {
		const state = await getState(appcmdExe, "site", siteName)
		if (state === null) {
			onLine(`\n[WARN] IIS site "${siteName}" not found — skipping\n`)
		} else if (state === "Started") {
			await runAppcmd(appcmdExe, ["stop", "site", `/site.name:${siteName}`])
			stopped.site = true
			onLine(`\nStopped IIS site "${siteName}"\n`)
		} else {
			onLine(`\nIIS site "${siteName}" was already ${state} — leaving it alone\n`)
		}
	}

	if (appPoolName) {
		const state = await getState(appcmdExe, "apppool", appPoolName)
		if (state === null) {
			onLine(`\n[WARN] IIS app pool "${appPoolName}" not found — skipping\n`)
		} else if (state === "Started") {
			await runAppcmd(appcmdExe, ["stop", "apppool", `/apppool.name:${appPoolName}`])
			stopped.pool = true
			onLine(`\nStopped IIS app pool "${appPoolName}"\n`)
		} else {
			onLine(`\nIIS app pool "${appPoolName}" was already ${state} — leaving it alone\n`)
		}
	}

	// Whatever this call stopped is what the matching start call will restore, so
	// a site the user had deliberately stopped is never silently switched on.
	return stopped
}

async function startIis(appcmdExe, siteName, appPoolName, stopped, onLine) {
	if (stopped && stopped.pool && appPoolName) {
		try {
			await runAppcmd(appcmdExe, ["start", "apppool", `/apppool.name:${appPoolName}`])
			onLine(`\nStarted IIS app pool "${appPoolName}"\n`)
		} catch (err) {
			onLine(`\n[WARN] could not start app pool "${appPoolName}": ${err.message}\n`)
		}
	}

	if (stopped && stopped.site && siteName) {
		try {
			await runAppcmd(appcmdExe, ["start", "site", `/site.name:${siteName}`])
			onLine(`\nStarted IIS site "${siteName}"\n`)
		} catch (err) {
			onLine(`\n[WARN] could not start site "${siteName}": ${err.message}\n`)
		}
	}
}

module.exports = { stopIis, startIis, runAppcmd }
