import { join } from "node:path";
import type {
	NativeInboxReply,
	NativeInboxRequest,
	NativeInboxRoute,
} from "../../../resources/gui-bridge/agent-inbox-contracts";
import { type InboxSession, NativeInboxController } from "../../../resources/gui-bridge/agent-inbox-engine";
import { LOCAL_UPLOAD_DEVICE, UploadStore } from "../web/uploads";
import { AgentControl, type AgentControlFiles, type AgentControlHost, type ControlTab } from "./service";

export function nativeInboxFiles(root: string): AgentControlFiles {
	return {
		sendOutbox: join(root, "send-outbox.json"),
		mailOutbox: join(root, "mail-outbox.json"),
		attachments: join(root, "attachments"),
		inbox: { ledger: join(root, "inbox.json"), uploadUserData: join(root, "uploads") },
	};
}

export class NativeInboxStock {
	readonly requests: NativeInboxRequest[] = [];
	readonly followUps: unknown[] = [];
	readonly asides: unknown[] = [];
	readonly branch: unknown[] = [];
	readonly messages: unknown[] = [];
	readonly controller: NativeInboxController;
	readonly session: InboxSession;
	readonly admissions: { message: Record<string, unknown>; queue: "followUp" | "aside" | "journal" }[] = [];
	#path: string;
	#waiters: { predicate: (request: NativeInboxRequest) => boolean; resolve: (request: NativeInboxRequest) => void }[] =
		[];

	constructor(sessionPath: string, processInstance: string) {
		this.#path = sessionPath;
		const admit = (
			message: Record<string, unknown>,
			options: {
				onPromptQueued(messages: readonly unknown[]): void;
				onPromptAdmitted(): void;
			},
		) => {
			this.followUps.push(message);
			this.admissions.push({ message, queue: "followUp" });
			options.onPromptQueued([message]);
			options.onPromptAdmitted();
		};
		const session: InboxSession = {
			isStreaming: true,
			messages: this.messages,
			peekAsideMessages: () => this.asides,
			settleInFlightMessagePersistence: async () => {},
			agent: {
				streamFn: async function* (_model: unknown, _context: unknown, options: { events: readonly unknown[] }) {
					yield* options.events;
				},
				abort: () => {},
				requestModelBoundary: () => true,
				addBeforeModelCallHook: () => () => {},
				peekSteeringQueue: () => [],
				peekFollowUpQueue: () => this.followUps,
			},
			sessionManager: {
				getSessionFile: () => this.#path,
				getBranch: () => this.branch,
				appendCustomEntry: (customType, data) => this.branch.push({ type: "custom", customType, data }),
				flush: async () => {},
			},
			prompt: async (content, options) => {
				admit({ role: "user", content, attribution: options.attribution, provenance: options.provenance }, options);
			},
			sendCustomMessage: async message => {
				this.branch.push({ type: "custom_message", ...message });
				this.admissions.push({ message: { ...message }, queue: "journal" });
			},
			promptCustomMessage: async (message, options) => {
				admit({ role: "custom", ...message }, options);
			},
			transferQueuedMessagesToAside: (roots: readonly unknown[]) => {
				for (const root of roots) {
					const index = this.followUps.indexOf(root);
					if (index >= 0) {
						this.asides.push(...this.followUps.splice(index, 1));
						this.admissions.push({ message: root as Record<string, unknown>, queue: "aside" });
					}
				}
			},
		};
		this.session = session;
		this.controller = new NativeInboxController(session, processInstance);
	}

	async accept(request: NativeInboxRequest): Promise<NativeInboxReply> {
		const reply = await this.controller.accept(request);
		this.requests.push(request);
		for (const waiter of this.#waiters.splice(0)) {
			if (waiter.predicate(request)) waiter.resolve(request);
			else this.#waiters.push(waiter);
		}
		return reply;
	}

	waitForRequest(predicate: (request: NativeInboxRequest) => boolean = () => true): Promise<NativeInboxRequest> {
		const existing = this.requests.find(predicate);
		if (existing) return Promise.resolve(existing);
		const { promise, resolve } = Promise.withResolvers<NativeInboxRequest>();
		this.#waiters.push({ predicate, resolve });
		return promise;
	}

	journalQueued(): void {
		for (const message of [...this.followUps.splice(0), ...this.asides.splice(0)]) {
			const root = message as Record<string, unknown>;
			this.messages.push(root);
			if (root.role === "user") this.branch.push({ type: "message", message: root });
			else if (root.role === "custom") this.branch.push({ ...root, type: "custom_message" });
		}
	}

	status(): Promise<NativeInboxReply> {
		return this.controller.status();
	}

	async observeProviderOutput(events: readonly unknown[]): Promise<readonly unknown[]> {
		const streamFn = this.session.agent.streamFn;
		if (typeof streamFn !== "function") throw new Error("Missing controller provider stream");
		const response: unknown = await Reflect.apply(streamFn, this.session.agent, [
			undefined,
			{ messages: this.messages },
			{ events },
		]);
		if (!response || typeof response !== "object" || !(Symbol.asyncIterator in response))
			throw new Error("Controller provider stream is not observable");
		const output: unknown[] = [];
		for await (const event of response as AsyncIterable<unknown>) output.push(event);
		return output;
	}

	bridgeRequest(method: string, params: unknown): Promise<NativeInboxReply> {
		if (method === "agent_control.inbox_status") return this.status();
		if (method === "agent_control.inbox") return this.accept(params as NativeInboxRequest);
		return Promise.reject(new Error(`Unsupported fixture bridge request: ${method}`));
	}

	replaceReceiver(sessionPath: string): void {
		this.#path = sessionPath;
		this.controller.replaceReceiver();
	}
}

export class NativeInboxNetwork {
	readonly files: AgentControlFiles;
	readonly #source: AgentControlHost;
	readonly #root: string;
	readonly #stocks: Map<string, NativeInboxStock>;
	readonly #receivers = new Map<string, AgentControl>();
	#control: AgentControl | undefined;

	constructor(source: AgentControlHost, root: string, stocks: Map<string, NativeInboxStock>) {
		this.#source = source;
		this.#root = root;
		this.#stocks = stocks;
		this.files = nativeInboxFiles(root);

		source.runtime ??= {
			sweepMs: 0,
			reach: async path => {
				const tab = this.#targets().find(target => !target.device && target.sessionPath === path);
				if (!tab) throw new Error(`No local session at ${path}`);
				source.start(tab.tabId);
				return tab.tabId;
			},
			reviewSent: tabId => source.reviewChanged?.(tabId),
			nextPromptChildren: () => {},
			closedChildren: rows => {
				for (const row of rows) source.recordClosed(row);
			},
			wakeDone: () => {},
		};
		source.inboxStatus ??= async (tabId, path, device) => {
			const target = this.#target(tabId);
			if (target.sessionPath !== path || target.device !== device) throw new Error("Inbox target changed");
			const reply = await this.#stock(tabId).status();
			if (reply.receiver.sessionPath !== path) throw new Error("Inbox receiver changed");
			return reply;
		};
		source.deliverInbox ??= async (tabId, request) => this.#stock(tabId).accept(request);
		source.inbox ??= async (tabId, transfer) => {
			const target = this.#target(tabId);
			if (!target.sessionPath || target.sessionPath !== transfer.receiver.sessionPath || !target.runtimeInstance)
				throw new Error("Inbox target changed");
			if (!target.device) {
				if (!this.#control) throw new Error("Source control is not bound");
				return this.#control.runtime.acceptInbox({
					tabId,
					transfer,
					uploadDeviceId: LOCAL_UPLOAD_DEVICE,
					expectedProducerDeviceId: source.deviceId,
					expectedRuntimeInstance: target.runtimeInstance,
				});
			}
			const route = this.#route(target);
			return this.#receiver(target.device).runtime.acceptInbox({
				tabId,
				transfer,
				uploadDeviceId: source.deviceId,
				expectedProducerDeviceId: source.deviceId,
				expectedRuntimeInstance: target.runtimeInstance,
				expectedRoute: route,
			});
		};
		source.land ??= async (tabId, name, bytes) => {
			const target = this.#target(tabId);
			const uploadRoot = target.device ? this.#receiverRoot(target.device) : join(root, "uploads");
			const uploads = new UploadStore({ userData: uploadRoot });
			const device = target.device ? source.deviceId : LOCAL_UPLOAD_DEVICE;
			try {
				return { ok: true, path: (await uploads.store(device, name, bytes)).path };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		};
	}

	bind(control: AgentControl): void {
		this.#control = control;
	}

	get requests(): NativeInboxRequest[] {
		return [...this.#stocks.values()].flatMap(stock => stock.requests);
	}

	get admissions(): NativeInboxStock["admissions"] {
		return [...this.#stocks.values()].flatMap(stock => stock.admissions);
	}

	close(): void {
		for (const receiver of this.#receivers.values()) receiver.close();
		this.#receivers.clear();
	}

	#targets(): ControlTab[] {
		return [...this.#source.tabs(), ...(this.#source.mailTargets?.() ?? [])];
	}

	#target(tabId: string): ControlTab {
		const target = this.#targets().find(tab => tab.tabId === tabId);
		if (!target) throw new Error(`Inbox target ${tabId} is not open`);
		return target;
	}

	#stock(tabId: string): NativeInboxStock {
		const stock = this.#stocks.get(tabId);
		if (!stock) throw new Error(`Inbox bridge ${tabId} is unavailable`);
		return stock;
	}

	#receiverRoot(device: string): string {
		return join(this.#root, "receivers", encodeURIComponent(device), "uploads");
	}

	#route(target: ControlTab): NativeInboxRoute {
		if (!target.sessionPath || !target.runtimeInstance) throw new Error("Inbox target has no current runtime");
		return {
			peerDeviceId: this.#source.deviceId,
			connectionIncarnation: `fixture-connection:${target.device}`,
			rtab: target.tabId,
			tabId: target.tabId,
			sessionPath: target.sessionPath,
			runtimeInstance: target.runtimeInstance,
		};
	}

	#receiver(device: string): AgentControl {
		const existing = this.#receivers.get(device);
		if (existing) return existing;
		const source = this.#source;
		const targets = () => this.#targets().filter(tab => tab.device === device);
		const local = (tab: ControlTab) => {
			const { device: _device, deviceName: _deviceName, ...rest } = tab;
			return rest;
		};
		const overrides: Partial<AgentControlHost> = {
			deviceId: device,
			tabs: () =>
				source
					.tabs()
					.filter(tab => tab.device === device)
					.map(tab => ({ ...local(tab), window: tab.window })),
			mailTargets: () => (source.mailTargets?.() ?? []).filter(tab => tab.device === device).map(local),
			devices: () => [{ id: source.deviceId, name: source.deviceId, state: "online" }],
			inboxRoutes: () =>
				targets()
					.filter(tab => tab.sessionPath && tab.runtimeInstance)
					.map(tab => this.#route(tab)),
			inboxStatus: async (tabId, path) => {
				const tab = this.#target(tabId);
				if (tab.device !== device || tab.sessionPath !== path) throw new Error("Inbox target changed");
				return this.#stock(tabId).status();
			},
			deliverInbox: async (tabId, request) => this.#stock(tabId).accept(request),
			runtime: { ...source.runtime!, sweepMs: 0 },
		};
		const host = new Proxy(source, {
			get(target, property, receiver) {
				if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property);
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const receiverRoot = join(this.#root, "receivers", encodeURIComponent(device));
		const control = new AgentControl(host, { files: nativeInboxFiles(receiverRoot) });
		this.#receivers.set(device, control);
		return control;
	}
}
