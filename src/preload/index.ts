/**
 * Preload script: exposes the OmpApi on window.omp via contextBridge, built by
 * the shared `createOmpApi` over `ipcRenderer`. Event subscriptions return
 * unsubscribe functions. Only `fs.pathForFile` is answered here: a dropped
 * file's local path is Electron's to know.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { OmpApi } from "../shared/ipc-types";
import { createOmpApi, type OmpTransport } from "../shared/omp-api";

const electronTransport: OmpTransport = {
	invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
	send: (channel, ...args) => ipcRenderer.send(channel, ...args),
	on: (channel, listener) => {
		const forward = (_event: Electron.IpcRendererEvent, data: unknown) => listener(data);
		ipcRenderer.on(channel, forward);
		return () => {
			ipcRenderer.removeListener(channel, forward);
		};
	},
};

const shared = createOmpApi(electronTransport);
const api: OmpApi = {
	...shared,
	fs: { ...shared.fs, pathForFile: (file: File) => webUtils.getPathForFile(file) },
};

contextBridge.exposeInMainWorld("omp", api);
