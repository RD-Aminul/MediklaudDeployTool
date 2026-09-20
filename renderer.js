let config = null

const projectSelect = document.getElementById("projectSelect")
const presetSelect = document.getElementById("presetSelect")
const envSelectGroup = document.getElementById("envSelectGroup")
const variantSelect = document.getElementById("variantSelect")
const variantSelectGroup = document.getElementById("variantSelectGroup")
const destInfo = document.getElementById("destInfo")
const zipCheckbox = document.getElementById("stepZip")
const zipStepLabel = document.getElementById("zipStepLabel")
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
const askModal = document.getElementById("askModal")
const askModalMessage = document.getElementById("askModalMessage")
const askModalInput = document.getElementById("askModalInput")
const askModalOk = document.getElementById("askModalOk")
const askModalCancel = document.getElementById("askModalCancel")

const STEPS = ["gitPull", "patch", "build", "zip"]

// Electron does not implement window.prompt() — it returns null without ever
// showing anything, which is why the Add buttons appeared to do nothing. This
// is the stand-in: same contract (text, or null when cancelled).
function askText(message) {
	return new Promise(resolve => {
		askModalMessage.textContent = message
		askModalInput.value = ""
		askModal.hidden = false
		askModalInput.focus()

		const close = value => {
			askModal.hidden = true
			askModalOk.onclick = null
			askModalCancel.onclick = null
			askModalInput.onkeydown = null
			resolve(value)
		}

		askModalOk.onclick = () => close(askModalInput.value)
		askModalCancel.onclick = () => close(null)
		askModalInput.onkeydown = event => {
			if (event.key === "Enter") close(askModalInput.value)
			else if (event.key === "Escape") close(null)
		}
	})
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
function renderDestInfo() {
	const project = currentProject()
	const env = currentEnv()
	if (!project || !env) return
	if (env.variants && !currentVariant()) return // variant list still populating

	const variant = currentVariant()
	// A variant owns its whole deployment (publish path, archive, IIS, runtime),
	// not just its connection values — fall back to the environment only for
	// whatever a variant leaves unset.
	const inherit = field => (variant && variant[field] !== undefined ? variant[field] : env[field])
	const publishDir = (inherit("publishDir") || "").trim()
	const archiveName = (inherit("archiveName") || "").trim()
	const rid = (inherit("runtimeIdentifier") || "").trim()
	const folders = project.artifacts.map(a => a.folder).join(", ")

	const target = publishDir || `${config.tools.outputRoot}\\<timestamp>`
	const lines = [`<div><span class="dk">Publishes to</span>${escapeHtml(target)}\\{${escapeHtml(folders)}}</div>`]

	if (publishDir) {
		const site = (inherit("iisSiteName") || "").trim()
		const pool = (inherit("iisAppPool") || "").trim()
		if (site || pool) {
			const what = [site && `site "${site}"`, pool && `pool "${pool}"`].filter(Boolean).join(" + ")
			lines.push(`<div><span class="dk">IIS</span>stops ${escapeHtml(what)}, starts it again after</div>`)
		}
		lines.push(`<div><span class="dk">Existing files</span>cleared from those folders before build</div>`)
	}

	lines.push(
		`<div><span class="dk">API build</span>${
			rid ? `self-contained, ${escapeHtml(rid)}` : "framework-dependent, portable"
		}</div>`
	)
	lines.push(
		`<div><span class="dk">Archive</span>${archiveName ? escapeHtml(archiveName) : "none — files left unpacked"}</div>`
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
			const valueFieldsHtml = (values, variantKey) =>
				Object.keys(values || {})
					.map(field => {
						const variantAttr = variantKey ? ` data-variant="${escapeHtml(variantKey)}"` : ""
						return `
							<label>${escapeHtml(field)}</label>
							<input type="text" data-proj="${projKey}" data-env="${envKey}"${variantAttr} data-value-field="${field}"
							       value="${escapeHtml(values[field])}" />`
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
		rows.push(`<div><span class="k">${escapeHtml(k)}</span>${escapeHtml(v)}</div>`)
	})
	Object.entries(config.projects).forEach(([projKey, project]) => {
		Object.entries(project.repos).forEach(([id, p]) => {
			const branch = currentBranches[`${projKey}.${id}`]
			const branchNote = branch ? ` <span class="branch-tag">branch: ${escapeHtml(branch)}</span>` : ""
			rows.push(
				`<div><span class="k">${escapeHtml(project.label + " / " + id)}</span>${escapeHtml(p)}${branchNote}</div>`
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
	// Settings so the user notices the paths that got filled in (or didn't).
	document.querySelector('.tab[data-tab="settings"]').click()
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

manageProjectSelect.addEventListener("change", () => renderManageEnv())
manageEnvSelect.addEventListener("change", () => renderManageVariant())

/* ---------------- run ---------------- */

projectSelect.addEventListener("change", renderEnvSelect)
presetSelect.addEventListener("change", renderVariantSelect)
variantSelect.addEventListener("change", renderDestInfo)

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
		const result = await window.api.runPipeline(projectSelect.value, presetSelect.value, variantSelect.value, steps)
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
	alert(
		`Project "${label.trim()}" added.\n\nIts repo paths, build artifacts and patch rules aren't editable here yet — add those directly in config/environments.json before using it.`
	)
})

removeProjectBtn.addEventListener("click", async () => {
	const project = currentManageProject()
	if (!project) return
	if (!confirm(`Remove project "${project.label}"? This only edits the config — no files on disk are touched. It cannot be undone from here.`)) return

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
	if (!confirm(`Remove environment "${env.label}" from ${project.label}? This only edits the config.`)) return

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
		alert("Can't remove the last variant — an environment needs at least one.")
		return
	}
	if (!confirm(`Remove variant "${env.variants[variantKey].label}"?`)) return

	delete env.variants[variantKey]
	await window.api.saveConfig(config)
	renderProjectSelect()
	renderFilterProject()
	renderManageVariant()
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
