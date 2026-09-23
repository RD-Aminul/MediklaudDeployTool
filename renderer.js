let config = null

const projectSelect = document.getElementById("projectSelect")
const presetSelect = document.getElementById("presetSelect")
const envSelectGroup = document.getElementById("envSelectGroup")
const variantSelect = document.getElementById("variantSelect")
const variantSelectGroup = document.getElementById("variantSelectGroup")
const componentSelect = document.getElementById("componentSelect")
const destInfo = document.getElementById("destInfo")
const zipCheckbox = document.getElementById("stepZip")
const zipStepLabel = document.getElementById("zipStepLabel")
const gitPullStepLabel = document.getElementById("gitPullStepLabel")
const buildStepLabel = document.getElementById("buildStepLabel")
const runBtn = document.getElementById("runBtn")
const stopBtn = document.getElementById("stopBtn")
const logEl = document.getElementById("log")
const toggleLogBtn = document.getElementById("toggleLogBtn")
const resultBox = document.getElementById("resultBox")
const openFolderBtn = document.getElementById("openFolderBtn")
const presetEditor = document.getElementById("presetEditor")
const presetEmpty = document.getElementById("presetEmpty")
const filterProject = document.getElementById("filterProject")
const filterEnv = document.getElementById("filterEnv")
const filterEnvGroup = document.getElementById("filterEnvGroup")
const filterVariant = document.getElementById("filterVariant")
const filterVariantGroup = document.getElementById("filterVariantGroup")
const pathsView = document.getElementById("pathsView")
const saveConfigBtn = document.getElementById("saveConfigBtn")
const saveStatus = document.getElementById("saveStatus")
const detectPathsBtn = document.getElementById("detectPathsBtn")
const detectStatus = document.getElementById("detectStatus")
const detectResults = document.getElementById("detectResults")
const manageProjectSelect = document.getElementById("manageProjectSelect")
const manageEnvSelect = document.getElementById("manageEnvSelect")
const manageVariantSelect = document.getElementById("manageVariantSelect")
const addProjectBtn = document.getElementById("addProjectBtn")
const removeProjectBtn = document.getElementById("removeProjectBtn")
const addEnvBtn = document.getElementById("addEnvBtn")
const removeEnvBtn = document.getElementById("removeEnvBtn")
const addVariantBtn = document.getElementById("addVariantBtn")
const removeVariantBtn = document.getElementById("removeVariantBtn")
const manageStatus = document.getElementById("manageStatus")
const reposEditor = document.getElementById("reposEditor")
const artifactsEditor = document.getElementById("artifactsEditor")
const patchRulesEditor = document.getElementById("patchRulesEditor")
const addRepoBtn = document.getElementById("addRepoBtn")
const addArtifactBtn = document.getElementById("addArtifactBtn")
const addPatchRuleBtn = document.getElementById("addPatchRuleBtn")
const saveProjectSetupBtn = document.getElementById("saveProjectSetupBtn")
const projectSetupStatus = document.getElementById("projectSetupStatus")

// window.alert() is a blocking native dialog — on some window setups it can
// render behind the app or otherwise fail to grab focus, which then looks
// like the whole Manage tab has frozen (nothing responds until it's
// dismissed). This inline notice does the same job without ever blocking.
function showManageStatus(message) {
	manageStatus.textContent = message
	manageStatus.hidden = false
}
const askModal = document.getElementById("askModal")
const askModalMessage = document.getElementById("askModalMessage")
const askModalInput = document.getElementById("askModalInput")
const askModalOk = document.getElementById("askModalOk")
const askModalCancel = document.getElementById("askModalCancel")

const STEPS = ["gitPull", "patch", "build", "zip"]

// In-app stand-in for window.prompt()/confirm(). Electron doesn't implement
// prompt() at all, and after a native confirm()/alert() — or after hiding an
// element that still holds focus — it can leave the renderer without keyboard
// focus: inputs look normal but typing does nothing until the window is
// alt-tabbed away and back. So no native dialogs anywhere, focus is released
// before the modal hides, and each open asks the main process to hand
// keyboard focus back to the page before focusing the input.
//
// A stray second open while one is already showing (a double click) cancels
// the first rather than overwriting its handlers, so no caller's await is
// ever left hanging forever.
let closeCurrentModal = null

function showModal(message, withInput) {
	if (closeCurrentModal) closeCurrentModal(null)

	return new Promise(resolve => {
		askModalMessage.textContent = message
		askModalInput.value = ""
		askModalInput.hidden = !withInput
		askModal.hidden = false

		// Focus right away, then again once the main process has handed keyboard
		// focus back to the page — the second one is what makes typing work
		// when Electron had lost it. setTimeout rather than requestAnimationFrame
		// because rAF never fires while the window is minimised/hidden.
		const target = withInput ? askModalInput : askModalOk
		target.focus()
		Promise.resolve(window.api.focusWindow && window.api.focusWindow()).finally(() =>
			setTimeout(() => {
				if (!askModal.hidden) target.focus()
			}, 0)
		)

		const close = value => {
			if (askModal.contains(document.activeElement)) document.activeElement.blur()
			askModal.hidden = true
			askModalOk.onclick = null
			askModalCancel.onclick = null
			askModal.onkeydown = null
			closeCurrentModal = null
			resolve(value)
		}
		closeCurrentModal = close

		const ok = () => close(withInput ? askModalInput.value : true)
		askModalOk.onclick = ok
		askModalCancel.onclick = () => close(null)
		askModal.onkeydown = event => {
			if (event.key === "Enter") {
				event.preventDefault()
				ok()
			} else if (event.key === "Escape") {
				close(null)
			}
		}
	})
}

// Same contract as window.prompt(): the typed text, or null when cancelled.
function askText(message) {
	return showModal(message, true)
}

// Same contract as window.confirm(): true for OK, false for Cancel.
async function askConfirm(message) {
	return (await showModal(message, false)) === true
}

/* ---------------- tabs ---------------- */

document.querySelectorAll(".tab").forEach(tab => {
	tab.addEventListener("click", () => {
		document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"))
		document.querySelectorAll(".tab-page").forEach(p => p.classList.remove("active"))
		tab.classList.add("active")
		document.getElementById("tab-" + tab.dataset.tab).classList.add("active")
	})
})

/* ---------------- progress ---------------- */

function row(step) {
	return document.getElementById("row-" + step)
}

function setProgress(step, percent) {
	const el = row(step)
	if (!el) return
	el.querySelector(".progress-fill").style.width = percent + "%"
	el.querySelector(".progress-value").textContent = percent + "%"
}

function setStepState(step, state) {
	const el = row(step)
	if (!el) return
	el.classList.remove("running", "done", "error", "skipped")
	if (state) el.classList.add(state)
}

function resetProgress(steps) {
	STEPS.forEach(step => {
		setProgress(step, 0)
		setStepState(step, steps[step] ? null : "skipped")
	})
}

/* ---------------- log (hidden by default) ---------------- */

function appendLog(text) {
	logEl.textContent += text
	logEl.scrollTop = logEl.scrollHeight
}

toggleLogBtn.addEventListener("click", () => {
	logEl.hidden = !logEl.hidden
	toggleLogBtn.textContent = logEl.hidden ? "Show technical details" : "Hide technical details"
})

/* ---------------- helpers ---------------- */

function escapeHtml(str) {
	return String(str == null ? "" : str)
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
}

function currentProject() {
	return config.projects[projectSelect.value]
}

function currentEnv() {
	const p = currentProject()
	return p ? p.environments[presetSelect.value] : null
}

function currentVariant() {
	const env = currentEnv()
	return env && env.variants ? env.variants[variantSelect.value] : null
}

/* ---------------- dropdowns ---------------- */

function renderProjectSelect() {
	const previous = projectSelect.value
	projectSelect.innerHTML = ""
	Object.entries(config.projects).forEach(([key, project]) => {
		const opt = document.createElement("option")
		opt.value = key
		opt.textContent = project.label
		projectSelect.appendChild(opt)
	})
	if (previous && config.projects[previous]) projectSelect.value = previous
	renderEnvSelect()
}

function renderEnvSelect() {
	const project = currentProject()
	const previous = presetSelect.value
	presetSelect.innerHTML = ""
	if (!project) return

	const envEntries = Object.entries(project.environments)
	envEntries.forEach(([key, env]) => {
		const opt = document.createElement("option")
		opt.value = key
		opt.textContent = env.label
		presetSelect.appendChild(opt)
	})
	if (previous && project.environments[previous]) presetSelect.value = previous

	// A single-environment project has nothing to choose between, so the picker
	// would just be a control with one dead option — hide it.
	envSelectGroup.hidden = envEntries.length <= 1

	renderVariantSelect()
}

// Some environments (Global's per-client presets) offer more than one
// connection-string/API-URL pairing (e.g. Test vs. Live) — a "variants" map.
// Same rule as the environment picker: hide it when there is nothing to choose.
function renderVariantSelect() {
	const env = currentEnv()
	const previous = variantSelect.value
	variantSelect.innerHTML = ""

	const variantEntries = env && env.variants ? Object.entries(env.variants) : []
	variantEntries.forEach(([key, variant]) => {
		const opt = document.createElement("option")
		opt.value = key
		opt.textContent = variant.label
		variantSelect.appendChild(opt)
	})
	if (previous && env && env.variants && env.variants[previous]) variantSelect.value = previous

	variantSelectGroup.hidden = variantEntries.length <= 1

	renderDestInfo()
}

// Spells out exactly where this run will write and what it will produce, so the
// destructive "clear the publish folder" step is never a surprise.
// "both" (default) / "api" / "react" — react here means every non-dotnet
// artifact, so Jail's PMS + VMS both count as "react" for this purpose.
function selectedArtifactsFor(project) {
	const comp = componentSelect.value
	if (comp === "api") return project.artifacts.filter(a => a.type === "dotnet")
	if (comp === "react") return project.artifacts.filter(a => a.type !== "dotnet")
	return project.artifacts
}

// Short ids (api, pms, vms) are acronyms and read oddly title-cased, so those
// go fully upper-case; a longer one like "react" just gets its first letter
// capitalized.
function displayIdLabel(id) {
	return id.length <= 4 ? id.toUpperCase() : id.charAt(0).toUpperCase() + id.slice(1)
}

// The step checkboxes/progress rows say "Git Pull (API + React)" etc. by
// default — once a component filter narrows what's actually running, those
// need to say so too, or the labels visibly disagree with the info box below
// them.
function updateStepLabels(project) {
	const comp = componentSelect.value
	const dotnetLabels = project.artifacts.filter(a => a.type === "dotnet").map(a => displayIdLabel(a.id))
	const otherLabels = project.artifacts.filter(a => a.type !== "dotnet").map(a => displayIdLabel(a.id))

	const gitPullWhat = comp === "api" ? dotnetLabels : comp === "react" ? otherLabels : [...dotnetLabels, ...otherLabels]
	const buildWhat =
		comp === "api" ? "dotnet publish" : comp === "react" ? "yarn build" : "dotnet publish + yarn build"

	gitPullStepLabel.textContent = `Git Pull (${gitPullWhat.join(" + ")})`
	buildStepLabel.textContent = `Build (${buildWhat})`

	const gitPullRow = row("gitPull")
	const buildRow = row("build")
	if (gitPullRow) gitPullRow.querySelector(".progress-label").textContent = gitPullStepLabel.textContent
	if (buildRow) buildRow.querySelector(".progress-label").textContent = buildStepLabel.textContent
}

function renderDestInfo() {
	const project = currentProject()
	const env = currentEnv()
	if (!project || !env) return
	if (env.variants && !currentVariant()) return // variant list still populating

	updateStepLabels(project)

	const variant = currentVariant()
	// A variant owns its whole deployment (publish path, archive, IIS, runtime),
	// not just its connection values — fall back to the environment only for
	// whatever a variant leaves unset.
	const inherit = field => (variant && variant[field] !== undefined ? variant[field] : env[field])
	const publishDir = (inherit("publishDir") || "").trim()
	const archiveName = (inherit("archiveName") || "").trim()
	const rid = (inherit("runtimeIdentifier") || "").trim()
	const folders = project.artifacts.map(a => a.folder).join(", ")

	const building = selectedArtifactsFor(project)
	const includesApi = building.some(a => a.type === "dotnet")
	const buildingFolders = building.map(a => a.folder).join(", ")
	// A persistent publish folder already has both sides sitting in it from
	// past runs, so a partial rebuild still archives the complete pair; a
	// fresh timestamped folder only ever contains what this run built.
	const archiveFolders = publishDir ? folders : buildingFolders

	const target = publishDir || `${config.tools.outputRoot}\\<timestamp>`
	const lines = [`<div><span class="dk">Publishes to</span>${escapeHtml(target)}\\{${escapeHtml(folders)}}</div>`]

	if (building.length < project.artifacts.length) {
		lines.push(`<div><span class="dk">Building</span>${escapeHtml(buildingFolders)} only — the rest is left as-is</div>`)
	}

	if (publishDir) {
		const site = (inherit("iisSiteName") || "").trim()
		const pool = (inherit("iisAppPool") || "").trim()
		if (includesApi && (site || pool)) {
			const what = [site && `site "${site}"`, pool && `pool "${pool}"`].filter(Boolean).join(" + ")
			lines.push(`<div><span class="dk">IIS</span>stops ${escapeHtml(what)}, starts it again after</div>`)
		} else if (!includesApi) {
			lines.push(`<div><span class="dk">IIS</span>left running — API isn't part of this build</div>`)
		}
		lines.push(`<div><span class="dk">Existing files</span>cleared from ${escapeHtml(buildingFolders)} before build</div>`)
	}

	if (includesApi) {
		lines.push(
			`<div><span class="dk">API build</span>${
				rid ? `self-contained, ${escapeHtml(rid)}` : "framework-dependent, portable"
			}</div>`
		)
	}
	lines.push(
		`<div><span class="dk">Archive</span>${
			archiveName ? `${escapeHtml(archiveName)} ({${escapeHtml(archiveFolders)}})` : "none — files left unpacked"
		}</div>`
	)

	destInfo.innerHTML = lines.join("")

	// No archive configured means the step cannot run; make that visible rather
	// than silently ignoring a ticked box.
	if (archiveName) {
		zipCheckbox.disabled = false
		zipStepLabel.textContent = `Archive (${archiveName})`
	} else {
		zipCheckbox.disabled = true
		zipCheckbox.checked = false
		zipStepLabel.textContent = "Archive — not used for this environment"
	}
}

/* ---------------- settings ---------------- */

const ENV_FIELDS = [
	["publishDir", "Publish Folder (blank = timestamped folder under outputRoot)"],
	["archiveName", "Archive Name (blank = no archive)"],
	["runtimeIdentifier", "API Runtime (blank = portable / framework-dependent)"],
	["iisSiteName", "IIS Site to stop during publish (blank = none)"],
	["iisAppPool", "IIS App Pool to stop during publish (blank = none)"],
]

const ALL = "__all__"

function renderFilterProject() {
	const previous = filterProject.value
	filterProject.innerHTML = ""

	const allOpt = document.createElement("option")
	allOpt.value = ALL
	allOpt.textContent = "All projects"
	filterProject.appendChild(allOpt)

	Object.entries(config.projects).forEach(([key, project]) => {
		const opt = document.createElement("option")
		opt.value = key
		opt.textContent = project.label
		filterProject.appendChild(opt)
	})

	filterProject.value = previous && (previous === ALL || config.projects[previous]) ? previous : ALL
	renderFilterEnv()
}

function renderFilterEnv() {
	const previous = filterEnv.value
	filterEnv.innerHTML = ""

	const projKey = filterProject.value
	// With "All projects" selected there is no single environment list to offer,
	// so the environment filter has nothing to narrow by.
	const project = projKey === ALL ? null : config.projects[projKey]
	const envEntries = project ? Object.entries(project.environments) : []

	// A single-environment project has nothing to filter between, so "All
	// environments" vs. that one environment is a dead choice — hide the picker
	// and just show that environment (renderPresetEditor treats ALL and a lone
	// env key the same way).
	filterEnvGroup.hidden = project ? envEntries.length <= 1 : false
	filterEnv.disabled = !project

	if (envEntries.length > 1) {
		const allOpt = document.createElement("option")
		allOpt.value = ALL
		allOpt.textContent = "All environments"
		filterEnv.appendChild(allOpt)

		envEntries.forEach(([key, env]) => {
			const opt = document.createElement("option")
			opt.value = key
			opt.textContent = env.label
			filterEnv.appendChild(opt)
		})
		filterEnv.value = previous && project.environments[previous] ? previous : ALL
	} else {
		const allOpt = document.createElement("option")
		allOpt.value = ALL
		allOpt.textContent = "All environments"
		filterEnv.appendChild(allOpt)
		filterEnv.value = ALL
	}

	renderFilterVariant()
}

// Narrows further to one variant (Test/Live/...) within a single selected
// environment — only meaningful once both a specific project AND a specific
// environment that actually has variants are chosen.
function renderFilterVariant() {
	const previous = filterVariant.value
	filterVariant.innerHTML = ""

	const projKey = filterProject.value
	const envKey = filterEnv.value
	const project = projKey === ALL ? null : config.projects[projKey]
	const env = project && envKey !== ALL ? project.environments[envKey] : null
	const variantEntries = env && env.variants ? Object.entries(env.variants) : []

	// Same rule as the other two pickers: with one variant (or none) there is
	// nothing to narrow between, so "All variants" vs. that one entry is a dead
	// choice — hide it and let the editor show everything.
	filterVariantGroup.hidden = variantEntries.length <= 1

	const allOpt = document.createElement("option")
	allOpt.value = ALL
	allOpt.textContent = "All variants"
	filterVariant.appendChild(allOpt)

	if (variantEntries.length > 1) {
		variantEntries.forEach(([key, variant]) => {
			const opt = document.createElement("option")
			opt.value = key
			opt.textContent = variant.label
			filterVariant.appendChild(opt)
		})
		filterVariant.value = previous && env.variants[previous] ? previous : ALL
	} else {
		filterVariant.value = ALL
	}

	renderPresetEditor()
}

function renderPresetEditor() {
	presetEditor.innerHTML = ""

	const wantProject = filterProject.value
	const wantEnv = filterEnv.value
	const wantVariant = filterVariant.value
	let shown = 0

	Object.entries(config.projects).forEach(([projKey, project]) => {
		if (wantProject !== ALL && projKey !== wantProject) return

		const envEntries = Object.entries(project.environments).filter(
			([envKey]) => wantProject === ALL || wantEnv === ALL || envKey === wantEnv
		)
		if (envEntries.length === 0) return

		const head = document.createElement("h3")
		head.className = "project-head"
		head.textContent = project.label
		presetEditor.appendChild(head)

		envEntries.forEach(([envKey, env]) => {
			// A specific variant filter only narrows the environment it belongs to —
			// other environments in the same "All environments" listing keep all of
			// their own variants.
			const variantEntries = env.variants
				? Object.entries(env.variants).filter(
						([variantKey]) => wantEnv !== envKey || wantVariant === ALL || variantKey === wantVariant
				  )
				: null
			if (variantEntries && variantEntries.length === 0) return

			shown++
			const card = document.createElement("div")
			card.className = "preset-card"

			// Value fields (connectionString, apiBaseUrl, ...) live either directly on
			// the environment (DCCI/Jail — one pairing) or one level down per variant
			// (Global — Test/Live/... each with their own pairing). Either way they
			// get data-value-field inputs; variant ones also carry data-variant so the
			// save handler knows which nested object to write into.
			// Each value input gets a ▾ button that lists every value the
			// project's files already hold for that field (see openCandidatePopover).
			const valueFieldsHtml = (values, variantKey) =>
				Object.keys(values || {})
					.map(field => {
						const variantAttr = variantKey ? ` data-variant="${escapeHtml(variantKey)}"` : ""
						return `
							<label>${escapeHtml(field)}</label>
							<div class="value-field">
								<input type="text" data-proj="${projKey}" data-env="${envKey}"${variantAttr} data-value-field="${field}"
								       value="${escapeHtml(values[field])}" />
								<button type="button" class="pick-btn" title="Pick a value found in this project's files"
								        data-pick-proj="${projKey}" data-pick-env="${envKey}" data-pick-variant="${escapeHtml(variantKey || "")}"
								        data-pick-field="${field}">▾</button>
							</div>`
					})
					.join("")

			// A variant owns its whole deployment, not just its connection values —
			// publish path, archive name, runtime, and IIS target are each edited per
			// variant too. A field left blank on the variant still falls back to the
			// environment's value at deploy time (see main.js/renderDestInfo); showing
			// that inherited value here as the starting default (rather than a blank
			// box) makes that fallback visible instead of looking unset.
			const envFieldsHtml = (target, variantKey) =>
				ENV_FIELDS.map(([field, label]) => {
					const variantAttr = variantKey ? ` data-variant="${escapeHtml(variantKey)}"` : ""
					const value = target[field] !== undefined && target[field] !== "" ? target[field] : env[field]
					return `
						<label>${escapeHtml(label)}</label>
						<input type="text" data-proj="${projKey}" data-env="${envKey}"${variantAttr} data-field="${field}"
						       value="${escapeHtml(value)}" />`
				}).join("")

			const variantsHtml = env.variants
				? variantEntries
						.map(
							([variantKey, variant]) => `
								<div class="variant-block">
									<h5>${escapeHtml(variant.label)}</h5>
									${valueFieldsHtml(variant.values, variantKey)}
									${envFieldsHtml(variant, variantKey)}
								</div>`
						)
						.join("")
				: valueFieldsHtml(env.values) + envFieldsHtml(env)

			card.innerHTML = `
				<h4>${escapeHtml(env.label)}</h4>
				<div class="field-note">${escapeHtml(env.note)}</div>
				${variantsHtml}
			`
			presetEditor.appendChild(card)
		})
	})

	presetEmpty.hidden = shown > 0
}

let currentBranches = {}

function renderPaths() {
	const rows = []
	Object.entries(config.tools).forEach(([k, v]) => {
		rows.push(`<div><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`)
	})
	Object.entries(config.projects).forEach(([projKey, project]) => {
		Object.entries(project.repos).forEach(([id, p]) => {
			const branch = currentBranches[`${projKey}.${id}`]
			const branchNote = branch ? ` <span class="branch-tag">branch: ${escapeHtml(branch)}</span>` : ""
			rows.push(
				`<div><span class="k">${escapeHtml(project.label + " / " + id)}</span><span class="v">${escapeHtml(p)}${branchNote}</span></div>`
			)
		})
	})
	pathsView.innerHTML = rows.join("")
}

async function refreshBranches() {
	currentBranches = await window.api.getCurrentBranches()
	renderPaths()
}

function renderDetectResults(results) {
	if (!results || results.length === 0) {
		detectResults.hidden = true
		detectResults.innerHTML = ""
		return
	}
	detectResults.hidden = false
	detectResults.innerHTML = results
		.map(r => {
			const label = `${r.projKey} / ${r.repoId} (${r.folderName})`
			return r.foundPath
				? `<div class="detect-row detect-found"><span class="k">${escapeHtml(label)}</span>found: ${escapeHtml(r.foundPath)}</div>`
				: `<div class="detect-row detect-missing"><span class="k">${escapeHtml(label)}</span>not found on this machine</div>`
		})
		.join("")
}

async function refreshAfterDetect(results) {
	config = await window.api.getConfig()
	await refreshBranches() // also re-renders paths
	renderDetectResults(results)
}

detectPathsBtn.addEventListener("click", async () => {
	detectPathsBtn.disabled = true
	detectStatus.textContent = "Scanning drives — this can take up to a minute..."
	try {
		const results = await window.api.detectPaths()
		detectStatus.textContent =
			results.length === 0 ? "All configured paths already exist — nothing to detect." : "Done."
		await refreshAfterDetect(results)
	} finally {
		detectPathsBtn.disabled = false
	}
})

window.api.onAutoDetectDone(async results => {
	// Surfacing this only matters when something was actually missing — jump to
	// Detect Projects so the user notices the paths that got filled in (or didn't).
	document.querySelector('.tab[data-tab="detect"]').click()
	detectStatus.textContent = "Paths auto-detected on first launch."
	await refreshAfterDetect(results)
})

async function init() {
	config = await window.api.getConfig()
	renderProjectSelect()
	renderFilterProject() // also renders the editor
	renderManageProject()
	renderPaths()
	refreshBranches()
}

filterProject.addEventListener("change", renderFilterEnv)
filterEnv.addEventListener("change", renderFilterVariant)
filterVariant.addEventListener("change", renderPresetEditor)

manageProjectSelect.addEventListener("change", () => {
	renderManageEnv()
	renderProjectSetup()
})
manageEnvSelect.addEventListener("change", () => renderManageVariant())

/* ---------------- run ---------------- */

projectSelect.addEventListener("change", renderEnvSelect)
presetSelect.addEventListener("change", renderVariantSelect)
variantSelect.addEventListener("change", renderDestInfo)
componentSelect.addEventListener("change", renderDestInfo)

runBtn.addEventListener("click", async () => {
	logEl.textContent = ""
	resultBox.textContent = ""
	resultBox.classList.remove("failed")
	openFolderBtn.hidden = true
	runBtn.disabled = true
	runBtn.hidden = true
	stopBtn.hidden = false
	stopBtn.disabled = false
	stopBtn.textContent = "Stop"

	const steps = {
		gitPull: document.getElementById("stepGitPull").checked,
		patch: document.getElementById("stepPatch").checked,
		build: document.getElementById("stepBuild").checked,
		zip: document.getElementById("stepZip").checked,
	}

	resetProgress(steps)

	try {
		const result = await window.api.runPipeline(
			projectSelect.value,
			presetSelect.value,
			variantSelect.value,
			steps,
			componentSelect.value
		)
		resultBox.textContent = result.zipPath
			? `Done. Archive created at: ${result.zipPath}`
			: `Done. Output folder: ${result.runDir}`
		openFolderBtn.hidden = false
		openFolderBtn.onclick = () => window.api.openFolder(result.runDir)
	} catch (err) {
		resultBox.textContent = err.message.includes("Cancelled by user") ? "Cancelled." : `Failed: ${err.message}`
		resultBox.classList.add("failed")
		if (logEl.hidden) {
			logEl.hidden = false
			toggleLogBtn.textContent = "Hide technical details"
		}
	} finally {
		runBtn.disabled = false
		runBtn.hidden = false
		stopBtn.hidden = true
	}
})

stopBtn.addEventListener("click", async () => {
	stopBtn.disabled = true
	stopBtn.textContent = "Stopping…"
	await window.api.cancelPipeline()
})

/* ---------------- add / remove project, environment, variant ---------------- */

function slugify(label) {
	const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")
	return /^\d*$/.test(slug) ? "x" + slug : slug || "item"
}

function uniqueKey(base, existingKeysObj) {
	let key = base
	let i = 2
	while (existingKeysObj[key]) key = base + i++
	return key
}

// Every environment/variant needs one input per field the project's patch
// rules actually touch, so a fresh one starts with the same fields as its
// siblings (just blank) instead of an empty, useless card.
function fieldsForProject(project) {
	return [...new Set((project.patchRules || []).map(r => r.field))]
}

function blankValues(fields) {
	const values = {}
	fields.forEach(f => (values[f] = ""))
	return values
}

function currentManageProject() {
	return config.projects[manageProjectSelect.value] || null
}
function currentManageEnv() {
	const project = currentManageProject()
	return project ? project.environments[manageEnvSelect.value] || null : null
}

function renderManageProject(forceKey) {
	const previous = forceKey || manageProjectSelect.value
	manageProjectSelect.innerHTML = ""

	Object.entries(config.projects).forEach(([key, project]) => {
		const opt = document.createElement("option")
		opt.value = key
		opt.textContent = project.label
		manageProjectSelect.appendChild(opt)
	})
	if (previous && config.projects[previous]) manageProjectSelect.value = previous

	removeProjectBtn.disabled = Object.keys(config.projects).length === 0
	renderManageEnv()
	renderProjectSetup()
}

function renderManageEnv(forceKey) {
	const project = currentManageProject()
	const previous = forceKey || manageEnvSelect.value
	manageEnvSelect.innerHTML = ""

	const envEntries = project ? Object.entries(project.environments) : []
	if (envEntries.length === 0) {
		const opt = document.createElement("option")
		opt.textContent = "No environments yet"
		manageEnvSelect.appendChild(opt)
		manageEnvSelect.disabled = true
	} else {
		manageEnvSelect.disabled = false
		envEntries.forEach(([key, env]) => {
			const opt = document.createElement("option")
			opt.value = key
			opt.textContent = env.label
			manageEnvSelect.appendChild(opt)
		})
		if (previous && project.environments[previous]) manageEnvSelect.value = previous
	}

	addEnvBtn.disabled = !project
	removeEnvBtn.disabled = envEntries.length === 0
	renderManageVariant()
}

function renderManageVariant(forceKey) {
	const env = currentManageEnv()
	const previous = forceKey || manageVariantSelect.value
	manageVariantSelect.innerHTML = ""

	const variantEntries = env && env.variants ? Object.entries(env.variants) : []
	if (variantEntries.length === 0) {
		const opt = document.createElement("option")
		opt.textContent = env && env.variants ? "No variants yet" : "This environment has no variants"
		manageVariantSelect.appendChild(opt)
		manageVariantSelect.disabled = true
	} else {
		manageVariantSelect.disabled = false
		variantEntries.forEach(([key, variant]) => {
			const opt = document.createElement("option")
			opt.value = key
			opt.textContent = variant.label
			manageVariantSelect.appendChild(opt)
		})
		if (previous && env.variants[previous]) manageVariantSelect.value = previous
	}

	// An environment with no variants yet can still get its first one — adding
	// converts it (see the add handler), so this only needs an environment.
	addVariantBtn.disabled = !env
	removeVariantBtn.disabled = variantEntries.length <= 1
}

/* ---------------- project setup (repos / artifacts / patch rules) ---------------- */

const PATCH_KINDS = ["json", "cs", "js", "env"]
const ARTIFACT_TYPES = ["dotnet", "yarn"]

function optionsHtml(values, selected) {
	return values
		.map(v => `<option value="${escapeHtml(v)}"${v === selected ? " selected" : ""}>${escapeHtml(v)}</option>`)
		.join("")
}

// The artifact/rule repo dropdowns list whatever ids are typed in the Repos
// rows right now — unsaved ones included — so a repo added a moment ago can be
// picked straight away. A saved value that no longer matches any repo is kept
// visible (not silently swapped for another repo) so the mismatch is obvious.
function repoOptionsHtml(repoIds, selected) {
	const ids = selected && !repoIds.includes(selected) ? [selected, ...repoIds] : repoIds
	if (ids.length === 0) return `<option value="">(add a repo first)</option>`
	return optionsHtml(ids, selected || ids[0])
}

function currentRepoIds() {
	return [...reposEditor.querySelectorAll(".repo-id")].map(i => i.value.trim()).filter(Boolean)
}

function appendSetupRow(container, cls, html) {
	const row = document.createElement("div")
	row.className = `setup-row ${cls}`
	row.innerHTML = html
	container.appendChild(row)
	return row
}

function repoRowHtml(id = "", repoPath = "", branch = "") {
	return `
		<input type="text" class="repo-id" value="${escapeHtml(id)}" placeholder="api" />
		<input type="text" class="repo-path" value="${escapeHtml(repoPath)}" placeholder="E:\\Projects\\my_api_repo" />
		<input type="text" class="repo-branch" value="${escapeHtml(branch)}" placeholder="master" />
		<button type="button" class="small-btn danger-btn setup-remove">Remove</button>`
}

function artifactPathPlaceholder(type) {
	return type === "dotnet" ? "Web\\Web.csproj" : "build"
}

// One input covers both artifact kinds: a dotnet artifact needs its .csproj,
// a yarn one its build output folder (defaults to "build").
function artifactRowHtml(a = {}, repoIds = []) {
	const type = a.type || "dotnet"
	const pathValue = type === "dotnet" ? a.csproj || "" : a.buildDir || ""
	return `
		<input type="text" class="artifact-id" value="${escapeHtml(a.id || "")}" placeholder="api" />
		<select class="artifact-repo">${repoOptionsHtml(repoIds, a.repo)}</select>
		<select class="artifact-type">${optionsHtml(ARTIFACT_TYPES, type)}</select>
		<input type="text" class="artifact-path" value="${escapeHtml(pathValue)}" placeholder="${escapeHtml(artifactPathPlaceholder(type))}" />
		<input type="text" class="artifact-folder" value="${escapeHtml(a.folder || "")}" placeholder="api" />
		<button type="button" class="small-btn danger-btn setup-remove">Remove</button>`
}

function ruleRowHtml(r = {}, repoIds = []) {
	return `
		<select class="rule-repo">${repoOptionsHtml(repoIds, r.repo)}</select>
		<input type="text" class="rule-file" value="${escapeHtml(r.file || "")}" placeholder="Web\\appsettings.json" />
		<select class="rule-kind">${optionsHtml(PATCH_KINDS, r.kind || "json")}</select>
		<input type="text" class="rule-name" value="${escapeHtml(r.name || "")}" placeholder="DefaultConnection" />
		<input type="text" class="rule-field" value="${escapeHtml(r.field || "")}" placeholder="connectionString" />
		<button type="button" class="small-btn danger-btn setup-remove">Remove</button>`
}

function setProjectSetupStatus(message, kind) {
	projectSetupStatus.textContent = message
	projectSetupStatus.className = kind || ""
}

function renderProjectSetup() {
	const project = currentManageProject()
	setProjectSetupStatus("")

	for (const b of [addRepoBtn, addArtifactBtn, addPatchRuleBtn, saveProjectSetupBtn, addReactFolderBtn, autoSetupBtn]) {
		b.disabled = !project
	}
	renderSetupTables(project || {})
	renderQuickSetup(project)
}

// setup: { repos, branches, artifacts, patchRules } — a saved project, or the
// unsaved result of Auto Setup waiting for the Save button.
function renderSetupTables(setup) {
	reposEditor.innerHTML = ""
	artifactsEditor.innerHTML = ""
	patchRulesEditor.innerHTML = ""

	const branches = setup.branches || {}
	for (const [id, repoPath] of Object.entries(setup.repos || {})) {
		appendSetupRow(reposEditor, "setup-repo", repoRowHtml(id, repoPath, branches[id] || ""))
	}
	const repoIds = currentRepoIds()
	for (const a of setup.artifacts || []) appendSetupRow(artifactsEditor, "setup-artifact", artifactRowHtml(a, repoIds))
	for (const r of setup.patchRules || []) appendSetupRow(patchRulesEditor, "setup-rule", ruleRowHtml(r, repoIds))
}

/* ---------------- Quick Setup (folders -> Auto Setup) ---------------- */

// Most people setting up a project only know where its API and React folders
// are. They pick those here, Auto Setup (src/analyzer.js) works out the
// branch, build file and which file/key holds each connection string or API
// URL, and fills the Advanced tables — which the normal Save button then
// saves exactly as if they had been typed in by hand.
const quickFolders = document.getElementById("quickFolders")
const addReactFolderBtn = document.getElementById("addReactFolderBtn")
const autoSetupBtn = document.getElementById("autoSetupBtn")
const autoSetupResult = document.getElementById("autoSetupResult")
const advancedSetup = document.getElementById("advancedSetup")

// Rules found by the last Auto Setup run, each with a checkbox state, plus
// the repos/artifacts it produced — rebuilt into the tables on every toggle.
let quickState = null

function repoRole(project, repoId) {
	const artifact = (project.artifacts || []).find(a => a.repo === repoId)
	if (artifact) return artifact.type === "dotnet" ? "api" : "react"
	return /api/i.test(repoId) ? "api" : "react"
}

function quickRowHtml(role, id, repoPath, reactCount) {
	const label = role === "api" ? "API folder" : reactCount > 1 && id ? `React folder (${escapeHtml(id)})` : "React folder"
	const placeholder = role === "api" ? "E:\\Projects\\my_api" : "E:\\Projects\\my_react"
	const remove = role === "api" ? "" : `<button type="button" class="small-btn danger-btn quick-remove" title="Remove this folder">✕</button>`
	return `
		<div class="quick-row" data-role="${role}" data-id="${escapeHtml(id || "")}">
			<span class="quick-label">${role === "api" ? "🟦" : "⚛️"} ${label}</span>
			<input type="text" class="quick-path" value="${escapeHtml(repoPath || "")}" placeholder="${escapeHtml(placeholder)}" />
			<button type="button" class="small-btn quick-browse">Browse…</button>
			${remove}
		</div>`
}

function renderQuickSetup(project) {
	quickState = null
	autoSetupResult.hidden = true
	autoSetupResult.innerHTML = ""
	quickFolders.innerHTML = ""
	if (!project) return

	const repos = Object.entries(project.repos || {})
	const rows = repos.map(([id, repoPath]) => ({ role: repoRole(project, id), id, repoPath }))
	if (!rows.some(r => r.role === "api")) rows.unshift({ role: "api", id: "", repoPath: "" })
	if (!rows.some(r => r.role === "react")) rows.push({ role: "react", id: "", repoPath: "" })
	rows.sort((a, b) => (a.role === "api" ? 0 : 1) - (b.role === "api" ? 0 : 1))

	const reactCount = rows.filter(r => r.role === "react").length
	quickFolders.innerHTML = rows.map(r => quickRowHtml(r.role, r.id, r.repoPath, reactCount)).join("")
	// A project with nothing set up yet is exactly who the tables would scare off.
	if (repos.length === 0) advancedSetup.open = false
}

addReactFolderBtn.addEventListener("click", () => {
	quickFolders.insertAdjacentHTML("beforeend", quickRowHtml("react", "", "", 2))
	quickFolders.lastElementChild.querySelector(".quick-path").focus()
})

quickFolders.addEventListener("click", async e => {
	const row = e.target.closest(".quick-row")
	if (!row) return
	if (e.target.classList.contains("quick-remove")) {
		row.remove()
		return
	}
	if (!e.target.classList.contains("quick-browse")) return

	// Start the dialog next to a folder already picked — the API and React
	// repos of one project nearly always sit side by side.
	const input = row.querySelector(".quick-path")
	const anyPath = [...quickFolders.querySelectorAll(".quick-path")].map(i => i.value.trim()).find(Boolean)
	const start = input.value.trim() || (anyPath ? anyPath.replace(/[\\/][^\\/]+[\\/]?$/, "") : "")
	const picked = await window.api.pickFolder(start)
	await window.api.focusWindow() // a native dialog can leave inputs unfocusable
	if (picked) input.value = picked
})

// "jail_react_pms" -> "pms", "mediklaud-react-aster" -> "aster": the last word
// of the folder name tells several React apps of one project apart.
function reactIdFromPath(repoPath) {
	const base = repoPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "react"
	const word = base.split(/[_\-\s.]+/).filter(Boolean).pop() || base
	return slugify(word)
}

function camelField(name) {
	const words = name.replace(/^_+/, "").split(/[_\s]+/).filter(Boolean)
	if (words.length === 1) return words[0].charAt(0).toLowerCase() + words[0].slice(1)
	return words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join("")
}

autoSetupBtn.addEventListener("click", async () => {
	const project = currentManageProject()
	if (!project) return

	const rows = [...quickFolders.querySelectorAll(".quick-row")]
		.map(r => ({ role: r.dataset.role, id: r.dataset.id, path: r.querySelector(".quick-path").value.trim() }))
		.filter(r => r.path)
	if (rows.length === 0) {
		setProjectSetupStatus("Pick at least one folder first.", "warn")
		return
	}

	// Keep existing repo ids (other config refers to them); name new ones.
	const used = {}
	const reactRows = rows.filter(r => r.role === "react")
	for (const r of rows) {
		if (!r.id) {
			const existing = Object.entries(project.repos || {}).find(([, p]) => p.toLowerCase() === r.path.toLowerCase())
			r.id = existing ? existing[0] : r.role === "api" ? "api" : reactRows.length === 1 ? "react" : reactIdFromPath(r.path)
		}
		r.id = used[r.id] ? uniqueKey(r.id, used) : r.id
		used[r.id] = true
	}

	autoSetupBtn.disabled = true
	setProjectSetupStatus("Looking through the folders…")
	autoSetupResult.hidden = false
	autoSetupResult.innerHTML = `<div class="auto-scanning">🔍 Looking through the folders…</div>`
	let results
	try {
		results = await window.api.analyzeFolders(rows)
	} catch (err) {
		results = rows.map(r => ({ ...r, error: err.message }))
	} finally {
		autoSetupBtn.disabled = false
	}

	quickState = buildQuickState(project, results)
	renderAutoSetupResult()
	applyQuickState()
	const bad = results.filter(r => r.error).length
	setProjectSetupStatus(
		bad
			? "Some folders could not be read — fix the path and run Auto Setup again (their current setup is kept)."
			: "Found. Check the list above, then click Save Project Setup.",
		bad ? "warn" : "ok"
	)
})

// Turns analyzer results into a full setup, reusing what the project already
// has wherever it still fits: branch names, artifact ids/output folders, and
// the field name of any rule that was already set up (so values already typed
// on the Settings tab stay attached).
function buildQuickState(project, results) {
	const oldRules = project.patchRules || []
	const repos = {}
	const branches = {}
	const artifacts = []
	const rules = []

	for (const r of results) {
		if (r.error) {
			// A mistyped path must not wipe out what this repo already had —
			// carry its saved setup over untouched so Save can't lose it.
			if ((project.repos || {})[r.id] === undefined) continue
			repos[r.id] = project.repos[r.id]
			branches[r.id] = (project.branches || {})[r.id] || ""
			artifacts.push(...(project.artifacts || []).filter(a => a.repo === r.id).map(a => ({ ...a })))
			for (const x of oldRules.filter(x => x.repo === r.id)) {
				rules.push({ rule: { ...x }, role: r.role, count: 0, checked: true, status: "kept" })
			}
			continue
		}
		repos[r.id] = r.path
		branches[r.id] = (project.branches || {})[r.id] || r.branch || (r.role === "api" ? "master" : "main")

		const old = (project.artifacts || []).find(a => a.repo === r.id)
		if (r.role === "api") {
			const csproj = r.csproj || (old && old.csproj) || ""
			artifacts.push({ id: old ? old.id : r.id, repo: r.id, type: "dotnet", csproj, folder: old ? old.folder : "api" })
		} else {
			const buildDir = r.buildDir || (old && old.buildDir) || "build"
			artifacts.push({ id: old ? old.id : r.id, repo: r.id, type: "yarn", buildDir, folder: old ? old.folder : r.id })
		}

		const hadRules = oldRules.some(x => x.repo === r.id)
		for (const found of r.rules || []) {
			const existing = oldRules.find(x => x.repo === r.id && x.file === found.file && x.name === found.name)
			rules.push({
				rule: existing ? { ...existing, kind: found.kind } : { repo: r.id, file: found.file, kind: found.kind, name: found.name, field: "" },
				role: r.role,
				count: found.count,
				// Something new in a repo that was already set up is probably
				// an unused leftover (e.g. an old migration connection) — offer
				// it, but don't switch it on unasked.
				checked: existing ? true : !hadRules,
				status: existing ? "current" : "new",
			})
		}
		// Rules Auto Setup can't recognise (e.g. DCCI's PG_PACKAGE_NAME) stay.
		for (const x of oldRules.filter(x => x.repo === r.id)) {
			if (!rules.some(q => q.rule.repo === x.repo && q.rule.file === x.file && q.rule.name === x.name)) {
				rules.push({ rule: { ...x }, role: r.role, count: 0, checked: true, status: "kept" })
			}
		}
	}
	return { results, repos, branches, artifacts, rules }
}

// New rules get a field name only once it's known which ones are switched on:
// a project with a single connection string calls it "connectionString",
// several get one field each; every React app's API URL shares "apiBaseUrl"
// (same API server for all of them, as in Jail's PMS + VMS).
function assignFieldNames(rules) {
	const isFixed = q => q.rule.field && !q.autoField // named by the saved config
	const apiOn = rules.filter(q => q.checked && q.role === "api")
	const taken = new Set(rules.filter(isFixed).map(q => q.rule.field))
	for (const q of rules) {
		if (isFixed(q)) continue
		q.autoField = true
		if (q.role === "react") q.rule.field = "apiBaseUrl"
		else if (apiOn.length === 1 && apiOn[0] === q && !taken.has("connectionString")) q.rule.field = "connectionString"
		else q.rule.field = camelField(q.rule.name)
	}
}

function applyQuickState() {
	assignFieldNames(quickState.rules)
	renderSetupTables({
		repos: quickState.repos,
		branches: quickState.branches,
		artifacts: quickState.artifacts,
		patchRules: quickState.rules.filter(q => q.checked).map(q => q.rule),
	})
}

function renderAutoSetupResult() {
	const { results, rules } = quickState
	const folderLines = results
		.map(r => {
			const name = r.role === "api" ? "API" : `React${results.filter(x => x.role === "react").length > 1 ? ` (${escapeHtml(r.id)})` : ""}`
			if (r.error) return `<div class="auto-line bad">✖ <b>${name}</b> — ${escapeHtml(r.error)}: ${escapeHtml(r.path)}</div>`
			const what = r.role === "api" ? r.csproj || "no .csproj found" : `builds to "${r.buildDir}"`
			const branch = quickState.branches[r.id]
			const warn = (r.warnings || []).map(w => `<div class="auto-warn">⚠ ${escapeHtml(w)}</div>`).join("")
			return `<div class="auto-line ${r.warnings && r.warnings.length ? "warn" : "ok"}">✔ <b>${name}</b> — ${escapeHtml(what)} · branch <code>${escapeHtml(branch)}</code></div>${warn}`
		})
		.join("")

	const ruleLines = rules
		.map((q, i) => {
			// A kept rule can be anything (DCCI's PG_PACKAGE_NAME is a package
			// name), so it goes by its own field name instead of a guess.
			const kindLabel = q.status === "kept" ? escapeHtml(q.rule.field) : q.role === "api" ? "Connection string" : "API URL"
			const tag =
				q.status === "new" && !q.checked
					? `<span class="auto-tag">new — probably not needed</span>`
					: q.status === "kept"
					? `<span class="auto-tag">kept from current setup</span>`
					: ""
			const alternatives = q.count > 1 ? ` · ${q.count} options in file` : ""
			return `
				<label class="auto-rule">
					<input type="checkbox" data-rule-index="${i}"${q.checked ? " checked" : ""} />
					<span><b>${kindLabel}</b> <code>${escapeHtml(q.rule.name)}</code> ${tag}
					<small>${escapeHtml(q.rule.file)}${alternatives}</small></span>
				</label>`
		})
		.join("")

	autoSetupResult.hidden = false
	autoSetupResult.innerHTML = `
		${folderLines}
		<div class="auto-sub">Values that change per environment${rules.length ? " — untick any you don't want" : ""}:</div>
		${ruleLines || `<div class="auto-warn">⚠ Nothing found — add patch rules under Advanced.</div>`}`
}

autoSetupResult.addEventListener("change", e => {
	const i = e.target.dataset.ruleIndex
	if (i === undefined || !quickState) return
	quickState.rules[i].checked = e.target.checked
	applyQuickState()
})

// Renaming or removing a repo re-lists every repo dropdown. A selection that
// no longer exists falls back to the first repo rather than lingering as a
// half-typed id from a keystroke ago.
function refreshRepoDropdowns() {
	const ids = currentRepoIds()
	for (const sel of document.querySelectorAll("#artifactsEditor .artifact-repo, #patchRulesEditor .rule-repo")) {
		const current = sel.value
		sel.innerHTML = repoOptionsHtml(ids, ids.includes(current) ? current : "")
	}
}

reposEditor.addEventListener("input", e => {
	if (e.target.classList.contains("repo-id")) refreshRepoDropdowns()
})

artifactsEditor.addEventListener("change", e => {
	if (!e.target.classList.contains("artifact-type")) return
	const pathInput = e.target.closest(".setup-row").querySelector(".artifact-path")
	pathInput.placeholder = artifactPathPlaceholder(e.target.value)
})

for (const container of [reposEditor, artifactsEditor, patchRulesEditor]) {
	container.addEventListener("click", e => {
		if (!e.target.classList.contains("setup-remove")) return
		e.target.closest(".setup-row").remove()
		if (container === reposEditor) refreshRepoDropdowns()
	})
}

addRepoBtn.addEventListener("click", () => {
	appendSetupRow(reposEditor, "setup-repo", repoRowHtml()).querySelector(".repo-id").focus()
})
addArtifactBtn.addEventListener("click", () => {
	appendSetupRow(artifactsEditor, "setup-artifact", artifactRowHtml({}, currentRepoIds()))
		.querySelector(".artifact-id")
		.focus()
})
addPatchRuleBtn.addEventListener("click", () => {
	appendSetupRow(patchRulesEditor, "setup-rule", ruleRowHtml({}, currentRepoIds())).querySelector(".rule-file").focus()
})

saveProjectSetupBtn.addEventListener("click", async () => {
	const project = currentManageProject()
	if (!project) return

	const problems = []

	const repos = {}
	const branches = {}
	for (const row of reposEditor.querySelectorAll(".setup-row")) {
		const id = row.querySelector(".repo-id").value.trim()
		if (!id) continue
		if (repos[id] !== undefined) problems.push(`repo id "${id}" is listed twice`)
		const repoPath = row.querySelector(".repo-path").value.trim()
		const branch = row.querySelector(".repo-branch").value.trim()
		if (!repoPath) problems.push(`repo "${id}" has no folder path`)
		if (!branch) problems.push(`repo "${id}" has no deploy branch`)
		repos[id] = repoPath
		branches[id] = branch
	}

	const artifacts = []
	for (const row of artifactsEditor.querySelectorAll(".setup-row")) {
		const id = row.querySelector(".artifact-id").value.trim()
		if (!id) continue
		const type = row.querySelector(".artifact-type").value
		const pathValue = row.querySelector(".artifact-path").value.trim()
		const folder = row.querySelector(".artifact-folder").value.trim() || id
		// Same key order as the hand-written config, so saving an existing
		// project from here doesn't reshuffle environments.json in git diffs.
		if (type === "dotnet") {
			if (!pathValue) problems.push(`artifact "${id}" has no .csproj path`)
			artifacts.push({ id, repo: row.querySelector(".artifact-repo").value, type, csproj: pathValue, folder })
		} else {
			artifacts.push({ id, repo: row.querySelector(".artifact-repo").value, type, buildDir: pathValue || "build", folder })
		}
	}

	const patchRules = []
	for (const row of patchRulesEditor.querySelectorAll(".setup-row")) {
		const file = row.querySelector(".rule-file").value.trim()
		const name = row.querySelector(".rule-name").value.trim()
		const field = row.querySelector(".rule-field").value.trim()
		if (!file && !name && !field) continue
		if (!file || !name || !field) {
			problems.push(`a patch rule is missing its file, key or field`)
			continue
		}
		patchRules.push({ repo: row.querySelector(".rule-repo").value, file, kind: row.querySelector(".rule-kind").value, name, field })
	}

	// A reference to an undefined repo id would otherwise only surface
	// mid-deploy as "has no repo X".
	const dangling = [...new Set([...artifacts, ...patchRules].map(x => x.repo).filter(r => !repos[r]))]
	if (dangling.length) problems.push(`not defined under Repos: ${dangling.map(r => `"${r}"`).join(", ")}`)

	project.repos = repos
	project.branches = branches
	project.artifacts = artifacts
	project.patchRules = patchRules

	// Each environment/variant needs one input per field the patch rules touch
	// — add any newly introduced field (blank) so it shows up on the Settings
	// tab. Values already filled in are never touched, and a field whose rule
	// was removed is left in place rather than deleted, so nothing typed there
	// is lost to an accidental rule removal.
	const fields = fieldsForProject(project)
	for (const env of Object.values(project.environments || {})) {
		for (const target of env.variants ? Object.values(env.variants) : [env]) {
			target.values = target.values || {}
			for (const f of fields) if (!(f in target.values)) target.values[f] = ""
		}
	}

	await window.api.saveConfig(config)
	renderProjectSelect()
	renderFilterProject()
	refreshBranches()
	renderProjectSetup()

	if (problems.length) {
		setProjectSetupStatus(`Saved, but fix before deploying: ${problems.join("; ")}.`, "warn")
	} else {
		setProjectSetupStatus("Saved.", "ok")
	}
})

addProjectBtn.addEventListener("click", async () => {
	const label = await askText('New project name (e.g. "Sunrise Hospital"):')
	if (!label || !label.trim()) return
	const key = uniqueKey(slugify(label), config.projects)

	config.projects[key] = {
		label: label.trim(),
		repos: {},
		branches: {},
		artifacts: [],
		patchRules: [],
		environments: {},
	}

	await window.api.saveConfig(config)
	renderProjectSelect()
	renderFilterProject()
	renderManageProject(key)
	showManageStatus(
		`Project "${label.trim()}" added. Now pick its folders under Project Setup below and click Auto Setup.`
	)
})

removeProjectBtn.addEventListener("click", async () => {
	const project = currentManageProject()
	if (!project) return
	if (!(await askConfirm(`Remove project "${project.label}"? This only edits the config — no files on disk are touched. It cannot be undone from here.`))) return

	delete config.projects[manageProjectSelect.value]
	await window.api.saveConfig(config)
	renderProjectSelect()
	renderFilterProject()
	renderManageProject()
})

addEnvBtn.addEventListener("click", async () => {
	const project = currentManageProject()
	if (!project) return
	const label = await askText(`New environment name for ${project.label} (e.g. "Test Server"):`)
	if (!label || !label.trim()) return
	const key = uniqueKey(slugify(label), project.environments)

	const fields = fieldsForProject(project)
	const usesVariants = Object.values(project.environments).some(e => e.variants)
	const base = {
		label: label.trim(),
		note: "",
		publishDir: "",
		archiveName: "",
		runtimeIdentifier: "",
		iisSiteName: "",
		iisAppPool: "",
	}
	project.environments[key] = usesVariants
		? { ...base, variants: { live: { label: "Live", values: blankValues(fields) } } }
		: { ...base, values: blankValues(fields) }

	await window.api.saveConfig(config)
	renderProjectSelect()
	renderFilterProject()
	renderManageEnv(key)
})

removeEnvBtn.addEventListener("click", async () => {
	const project = currentManageProject()
	const envKey = manageEnvSelect.value
	if (!project || !envKey) return
	const env = project.environments[envKey]
	if (!(await askConfirm(`Remove environment "${env.label}" from ${project.label}? This only edits the config.`))) return

	delete project.environments[envKey]
	await window.api.saveConfig(config)
	renderProjectSelect()
	renderFilterProject()
	renderManageEnv()
})

addVariantBtn.addEventListener("click", async () => {
	const project = currentManageProject()
	const env = currentManageEnv()
	if (!project || !env) return
	const label = await askText(`New variant name for "${env.label}" (e.g. "Test"):`)
	if (!label || !label.trim()) return

	// An environment that still holds one flat set of values has to become a
	// variants one before it can hold a second. Its existing values move into a
	// "Default" variant rather than being dropped, so it keeps working as before.
	if (!env.variants) {
		env.variants = {
			default: { label: "Default", values: env.values || blankValues(fieldsForProject(project)) },
		}
		delete env.values
	}

	const key = uniqueKey(slugify(label), env.variants)
	env.variants[key] = { label: label.trim(), values: blankValues(fieldsForProject(project)) }

	await window.api.saveConfig(config)
	renderProjectSelect()
	renderFilterProject()
	renderManageVariant(key)
})

removeVariantBtn.addEventListener("click", async () => {
	const env = currentManageEnv()
	const variantKey = manageVariantSelect.value
	if (!env || !variantKey) return
	if (Object.keys(env.variants).length <= 1) {
		showManageStatus("Can't remove the last variant — an environment needs at least one.")
		return
	}
	if (!(await askConfirm(`Remove variant "${env.variants[variantKey].label}"?`))) return

	delete env.variants[variantKey]
	await window.api.saveConfig(config)
	renderProjectSelect()
	renderFilterProject()
	renderManageVariant()
})

/* ---------------- value pick list (Settings tab) ---------------- */

// The ▾ next to each preset value asks main.js to scan the project's patch
// target files (appsettings.json, DBConnection.cs, api.js, .env ...) for every
// value that key already has — active or commented out — and lists them so a
// connection string can be picked instead of retyped by hand. Scanned fresh on
// every open, so a line someone just added to a file shows up immediately.
const candidatePopover = document.getElementById("candidatePopover")
let popoverInput = null

function closeCandidatePopover() {
	candidatePopover.hidden = true
	candidatePopover.innerHTML = ""
	popoverInput = null
}

// "Live (Linux)" -> "live", "BNHL" -> "bnhl": the first word of an environment
// or variant name is the part that tells presets apart, and is what the files'
// own headings and comments tend to say next to each value.
function envKeyword(label) {
	const word = String(label || "").trim().split(/\s+/)[0] || ""
	return word.toLowerCase().replace(/[^a-z]/g, "")
}

function positionCandidatePopover(anchor) {
	const rect = anchor.getBoundingClientRect()
	const width = Math.max(rect.width, 420)
	const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
	const spaceBelow = window.innerHeight - rect.bottom - 8
	const spaceAbove = rect.top - 8
	const placeAbove = spaceBelow < 260 && spaceAbove > spaceBelow
	const maxHeight = Math.min(420, placeAbove ? spaceAbove - 6 : spaceBelow - 6)

	candidatePopover.style.left = `${left}px`
	candidatePopover.style.width = `${Math.min(width, window.innerWidth - 16)}px`
	candidatePopover.style.maxHeight = `${Math.max(160, maxHeight)}px`
	if (placeAbove) {
		candidatePopover.style.top = ""
		candidatePopover.style.bottom = `${window.innerHeight - rect.top + 6}px`
	} else {
		candidatePopover.style.bottom = ""
		candidatePopover.style.top = `${rect.bottom + 6}px`
	}
}

function candidateItemHtml(cand, currentValue) {
	const badges = [
		cand.active ? `<span class="cand-badge active">active in file</span>` : "",
		cand.value === currentValue ? `<span class="cand-badge current">in this preset</span>` : "",
	].join("")
	return `
		<button type="button" class="cand-item" data-value="${escapeHtml(cand.value)}">
			<div class="cand-top">
				<span class="cand-label">${cand.label ? escapeHtml(cand.label) : `<em>(no comment)</em>`}</span>
				${badges}
			</div>
			<div class="cand-value">${escapeHtml(cand.value)}</div>
		</button>`
}

// Keeps the file's own heading blocks ("02.BNHL", "LIVE SERVER ...") together
// under a small header, in the order the file lists them.
function candidateGroupsHtml(list, currentValue) {
	let html = ""
	let lastGroup = null
	list.forEach(cand => {
		if (cand.group !== lastGroup) {
			if (cand.group) html += `<div class="cand-group">${escapeHtml(cand.group)}</div>`
			lastGroup = cand.group
		}
		html += candidateItemHtml(cand, currentValue)
	})
	return html
}

function renderCandidateList(candidates, keywords, filter) {
	const list = candidatePopover.querySelector(".cand-list")
	const currentValue = popoverInput ? popoverInput.value : ""
	const q = filter.trim().toLowerCase()
	const shown = q
		? candidates.filter(c => `${c.group} ${c.label} ${c.value}`.toLowerCase().includes(q))
		: candidates

	if (shown.length === 0) {
		list.innerHTML = `<div class="cand-empty">No value matches "${escapeHtml(filter)}".</div>`
		return
	}

	// A value whose heading/comment names both the environment and the variant
	// ("02.BNHL" + "BNHL live Linux") ranks above one that names only one of them.
	const score = c => {
		const words = `${c.group} ${c.label}`.toLowerCase().replace(/[^a-z]+/g, " ").split(" ")
		return keywords.filter(k => words.includes(k)).length
	}
	const matching = shown.filter(c => score(c) > 0).sort((a, b) => score(b) - score(a))
	const others = shown.filter(c => score(c) === 0)

	list.innerHTML = matching.length
		? `<div class="cand-section">Matches this environment</div>${candidateGroupsHtml(matching, currentValue)}` +
		  (others.length ? `<div class="cand-section">All other values</div>${candidateGroupsHtml(others, currentValue)}` : "")
		: candidateGroupsHtml(others, currentValue)
}

async function openCandidatePopover(btn) {
	const { pickProj, pickEnv, pickVariant, pickField } = btn.dataset
	const input = btn.parentElement.querySelector("input")
	if (popoverInput === input && !candidatePopover.hidden) {
		closeCandidatePopover()
		return
	}

	popoverInput = input
	candidatePopover.innerHTML = `<div class="cand-empty">Scanning project files…</div>`
	candidatePopover.hidden = false
	positionCandidatePopover(input)

	let result
	try {
		result = await window.api.scanCandidates(pickProj)
	} catch (err) {
		result = { fields: {}, problems: [err.message] }
	}
	if (popoverInput !== input) return // closed or re-opened elsewhere meanwhile

	const candidates = (result.fields && result.fields[pickField]) || []
	const problems = result.problems || []
	const env = config.projects[pickProj].environments[pickEnv]
	const keywords = [...new Set([env.label, pickVariant ? env.variants[pickVariant].label : ""].map(envKeyword))].filter(
		Boolean
	)

	const problemsHtml = problems.length
		? `<div class="cand-problems">${problems.map(p => `<div>⚠ ${escapeHtml(p)}</div>`).join("")}</div>`
		: ""

	if (candidates.length === 0) {
		candidatePopover.innerHTML = `
			<div class="cand-empty">No values for <b>${escapeHtml(pickField)}</b> were found in this project's files.</div>
			${problemsHtml}`
		return
	}

	candidatePopover.innerHTML = `
		<div class="cand-head">
			<input type="text" class="cand-filter" placeholder="Filter ${candidates.length} values found in the files…" />
		</div>
		${problemsHtml}
		<div class="cand-list"></div>`
	const filterInput = candidatePopover.querySelector(".cand-filter")
	renderCandidateList(candidates, keywords, "")
	filterInput.addEventListener("input", () => renderCandidateList(candidates, keywords, filterInput.value))
	filterInput.focus()
}

presetEditor.addEventListener("click", e => {
	const btn = e.target.closest(".pick-btn")
	if (btn) openCandidatePopover(btn)
})

candidatePopover.addEventListener("click", e => {
	const item = e.target.closest(".cand-item")
	if (!item || !popoverInput) return
	const input = popoverInput
	input.value = item.dataset.value
	closeCandidatePopover()
	input.focus()
	input.classList.add("just-picked")
	setTimeout(() => input.classList.remove("just-picked"), 900)
	saveStatus.classList.add("pending")
	saveStatus.textContent = "Unsaved changes — click Save Presets to keep them."
})

document.addEventListener("mousedown", e => {
	if (candidatePopover.hidden) return
	if (candidatePopover.contains(e.target) || e.target.closest(".pick-btn")) return
	closeCandidatePopover()
})

document.addEventListener("keydown", e => {
	if (e.key === "Escape" && !candidatePopover.hidden) closeCandidatePopover()
})

// The popover is position:fixed, so it would float away from its field when
// the page scrolls — simplest to just close it.
document.querySelectorAll(".content-area").forEach(el =>
	el.addEventListener("scroll", () => {
		if (!candidatePopover.hidden) closeCandidatePopover()
	})
)
window.addEventListener("resize", () => {
	if (!candidatePopover.hidden) closeCandidatePopover()
})

saveConfigBtn.addEventListener("click", async () => {
	presetEditor.querySelectorAll("input[data-proj]").forEach(input => {
		const { proj, env, field, valueField, variant } = input.dataset
		const envConfig = config.projects[proj].environments[env]
		const target = variant ? envConfig.variants[variant] : envConfig
		if (valueField) target.values[valueField] = input.value
		else target[field] = input.value
	})
	await window.api.saveConfig(config)
	saveStatus.classList.remove("pending")
	saveStatus.textContent = "Saved."
	renderProjectSelect()
	setTimeout(() => (saveStatus.textContent = ""), 2000)
})

/* ---------------- IPC ---------------- */

window.api.onLog(line => appendLog(line))

window.api.onProgress(({ step, percent }) => setProgress(step, percent))

window.api.onStep(({ step, status }) => {
	if (step === "error") {
		STEPS.forEach(s => {
			if (row(s).classList.contains("running")) setStepState(s, "error")
		})
		return
	}
	setStepState(step, status)
	if (status === "done") setProgress(step, 100)
})

init()
