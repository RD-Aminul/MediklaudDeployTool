const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("api", {
	getConfig: () => ipcRenderer.invoke("get-config"),
	saveConfig: cfg => ipcRenderer.invoke("save-config", cfg),
	runPipeline: (projectKey, envKey, variantKey, steps, component) =>
		ipcRenderer.invoke("run-pipeline", { projectKey, envKey, variantKey, steps, component }),
	cancelPipeline: () => ipcRenderer.invoke("cancel-pipeline"),
	openFolder: folderPath => ipcRenderer.invoke("open-folder", folderPath),
	focusWindow: () => ipcRenderer.invoke("focus-window"),
	scanCandidates: projectKey => ipcRenderer.invoke("scan-candidates", projectKey),
	pickFolder: startPath => ipcRenderer.invoke("pick-folder", startPath),
	analyzeFolders: folders => ipcRenderer.invoke("analyze-folders", folders),
	detectPaths: () => ipcRenderer.invoke("detect-paths"),
	getCurrentBranches: () => ipcRenderer.invoke("get-current-branches"),
	onLog: callback => ipcRenderer.on("log", (_evt, line) => callback(line)),
	onStep: callback => ipcRenderer.on("step", (_evt, data) => callback(data)),
	onProgress: callback => ipcRenderer.on("progress", (_evt, data) => callback(data)),
	onAutoDetectDone: callback => ipcRenderer.on("auto-detect-done", (_evt, results) => callback(results)),
})
