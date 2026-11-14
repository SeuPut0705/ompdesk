import { MAIL_CUSTOM_TYPE } from "./agent-control-contracts";
import { InboxContextObserver } from "./agent-inbox-context";
import {
	INBOX_CONTEXT_ENTRY,
	INBOX_PROVENANCE_SOURCE,
	type InboxContent,
	type InboxContextReceipt,
	type InboxReceiver,
	inboxIdentity,
	type NativeInboxEntry,
	type NativeInboxReply,
	type NativeInboxRequest,
} from "./agent-inbox-contracts";

interface PromptOptions {
	attribution: "agent";
	provenance: { source: string; id: string };
	streamingBehavior: "followUp";
	expandPromptTemplates: false;
	runCommands: false;
	throwOnDrop: true;
	images?: { type: "image"; data: string; mimeType: string }[];
	onPromptQueued(messages: readonly unknown[]): void;
	onPromptAdmitted(): void;
}

interface CustomPrompt {
	customType: string;
	content: InboxContent;
	display: boolean;
	attribution: "agent";
	provenance: { source: string; id: string };
	details: Record<string, unknown>;
}

export interface InboxSession {
	isStreaming: boolean;
	readonly messages: readonly unknown[];
	peekAsideMessages(): readonly unknown[];
	settleInFlightMessagePersistence(): Promise<void>;
	agent: {
		streamFn: unknown;
		abort: unknown;
		requestModelBoundary(): boolean;
		addBeforeModelCallHook(hook: (signal?: AbortSignal) => Promise<void>): () => void;
		peekSteeringQueue(): readonly unknown[];
		peekFollowUpQueue(): readonly unknown[];
	};
	sessionManager: {
		getSessionFile(): string | undefined;
		getBranch(): readonly unknown[];
		appendCustomEntry(type: string, data: unknown): unknown;
		flush(): Promise<void>;
	};
	prompt(text: string, options: PromptOptions): Promise<unknown>;
	sendCustomMessage(message: CustomPrompt, options: { triggerTurn: boolean }): Promise<unknown>;
	promptCustomMessage(
		message: CustomPrompt,
		options: {
			streamingBehavior: "aside" | "followUp";
			onPromptQueued(messages: readonly unknown[]): void;
			onPromptAdmitted(): void;
		},
	): Promise<unknown>;
	transferQueuedMessagesToAside: unknown;
}

type Method = (...args: unknown[]) => unknown;
let nextIncarnation = 0;
interface Registered {
	entry: NativeInboxEntry;
	roots: readonly unknown[];
	state: NativeInboxReply["entries"][number]["state"];
	admitted: boolean;
	stop: number;
	error?: string;
}
function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
function provenanceId(value: unknown): string | undefined {
	const provenance = object(object(value)?.provenance);
	return provenance?.source === INBOX_PROVENANCE_SOURCE && typeof provenance.id === "string"
		? provenance.id
		: undefined;
}
function contentParts(content: InboxContent): {
	text: string;
	images?: { type: "image"; data: string; mimeType: string }[];
} {
	if (typeof content === "string") return { text: content };
	const images: { type: "image"; data: string; mimeType: string }[] = [];
	const text: string[] = [];
	for (const part of content) {
		if (part.type === "text") text.push(part.text);
		else images.push(part);
	}
	return { text: text.join("\n"), ...(images.length ? { images } : {}) };
}

/** Candidate only: requires the unreleased stock boundary/transfer/provenance APIs. No fallback. */
export class NativeInboxController {
	readonly #session: InboxSession;
	readonly #processInstance: string;
	readonly #entries = new Map<string, Registered>();
	readonly #durableInputs = new Set<string>();
	readonly #oldObservers: InboxContextObserver[] = [];
	#observer: InboxContextObserver;
	#incarnation = ++nextIncarnation;
	#stops = 0;
	#tail: Promise<unknown> = Promise.resolve();
	#barrier: PromiseWithResolvers<void> | undefined;

	constructor(session: InboxSession, processInstance: string) {
		for (const member of [
			session.agent.requestModelBoundary,
			session.agent.streamFn,
			session.agent.abort,
			session.agent.addBeforeModelCallHook,
			session.transferQueuedMessagesToAside,
			session.promptCustomMessage,
			session.peekAsideMessages,
			session.agent.peekSteeringQueue,
			session.agent.peekFollowUpQueue,
			session.settleInFlightMessagePersistence,
		])
			if (typeof member !== "function")
				throw new Error("Native inbox requires the published stock model-boundary and exact queue-transfer APIs.");
		this.#session = session;
		if (!Array.isArray(session.messages)) throw new Error("Native inbox requires actual stock context messages.");
		this.#processInstance = processInstance;
		this.#observer = this.#newObserver();
		this.#observeProvider();
		const controller = this;
		const abort = session.agent.abort as Method;
		session.agent.abort = function (this: unknown, ...args: unknown[]) {
			controller.#stops++;
			controller.invalidate();
			return Reflect.apply(abort, this, args);
		};
		session.agent.addBeforeModelCallHook(async signal => {
			const barrier = this.#barrier;
			if (!barrier || signal?.aborted) return;
			const cancelled = Promise.withResolvers<void>();
			const stop = () => cancelled.resolve();
			signal?.addEventListener("abort", stop, { once: true });
			try {
				await Promise.race([barrier.promise, cancelled.promise]);
			} finally {
				signal?.removeEventListener("abort", stop);
			}
		});
	}

	get receiver(): InboxReceiver {
		return {
			sessionPath: this.#session.sessionManager.getSessionFile() ?? "",
			instance: `${this.#processInstance}:${this.#incarnation}`,
		};
	}

	invalidate(): void {
		this.#observer.invalidate();
	}

	/** Called by stock's completed session_switch hook, never inferred from equal prompt text. */
	replaceReceiver(): void {
		this.invalidate();
		this.#stops++;
		this.#incarnation = ++nextIncarnation;
		this.#oldObservers.push(this.#observer);
		this.#entries.clear();
		this.#durableInputs.clear();
		this.#observer = this.#newObserver();
	}

	accept(request: NativeInboxRequest): Promise<NativeInboxReply> {
		const run = this.#tail.then(() => this.#accept(request));
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async status(): Promise<NativeInboxReply> {
		for (const observer of this.#oldObservers) observer.retry();
		this.#observer.retry();
		await this.#session.sessionManager.flush();
		const receipts = this.#receipts();
		const observed = new Set(receipts.flatMap(receipt => receipt.ids));
		const journaled = this.#journaled();
		return {
			receiver: this.receiver,
			entries: [...this.#entries].map(([id, item]) => ({
				kind: item.entry.kind,
				deliveryId: item.entry.deliveryId,
				state:
					item.state === "legacy_ambiguous"
						? item.state
						: observed.has(id)
							? "context_observed"
							: journaled.has(id)
								? "journaled"
								: item.state,
				...(item.error ? { error: item.error } : {}),
			})),
			receipts,
		};
	}

	async #accept(request: NativeInboxRequest): Promise<NativeInboxReply> {
		this.#checkReceiver(request.receiver);
		const stop = this.#stops;
		const receiver = this.receiver;
		const journaled = this.#journaled();
		const present = this.#present();
		const pending = this.#pendingRoots(new Set(request.entries.map(inboxIdentity)));
		const fresh: Registered[] = [];
		for (const entry of request.entries) {
			const id = inboxIdentity(entry);
			const roots = pending.get(id) ?? [];
			const existing = this.#entries.get(id);
			if (existing) {
				existing.roots = roots;
				if (roots.length > 1) existing.state = "legacy_ambiguous";
				else if (existing.state === "failed" && existing.stop === stop) {
					if (roots.length > 0) {
						existing.admitted = true;
						existing.state = "accepted";
						delete existing.error;
					} else if (!existing.admitted && !journaled.has(id) && !present.has(id)) {
						existing.state = "accepted";
						delete existing.error;
						fresh.push(existing);
					}
				}
				continue;
			}
			const item: Registered = {
				entry,
				roots,
				state: entry.legacy || roots.length > 1 ? "legacy_ambiguous" : "accepted",
				admitted: roots.length > 0 || journaled.has(id) || present.has(id),
				stop,
			};
			this.#entries.set(id, item);
			if (item.state !== "legacy_ambiguous" && !item.admitted) fresh.push(item);
		}
		const barrier = Promise.withResolvers<void>();
		this.#barrier = barrier;
		try {
			for (const item of fresh) {
				if (stop !== this.#stops || receiver.instance !== this.receiver.instance) {
					item.state = "failed";
					item.error = "Receiver stopped or changed before admission; native outbox retains the entry.";
					continue;
				}
				this.#checkReceiver(receiver);
				const id = inboxIdentity(item.entry);
				item.roots = this.#pendingRoots(new Set([id])).get(id) ?? [];
				if (item.roots.length > 1) {
					item.state = "legacy_ambiguous";
					continue;
				}
				if (item.roots.length > 0 || this.#journaled().has(id) || this.#present().has(id)) {
					item.admitted = true;
					continue;
				}
				try {
					await this.#admit(item);
				} catch (error) {
					item.state = "failed";
					item.error = String(error);
				}
			}
			this.#checkReceiver(request.receiver);
			if (stop === this.#stops) {
				const current = this.#pendingRoots(new Set(this.#entries.keys()));
				for (const [id, item] of this.#entries) {
					item.roots = current.get(id) ?? [];
					if (item.roots.length > 1) item.state = "legacy_ambiguous";
				}
				const roots = [...this.#entries.values()]
					.filter(
						item =>
							item.entry.intent === "immediate" && item.state !== "legacy_ambiguous" && item.state !== "failed",
					)
					.flatMap(item => item.roots);
				Reflect.apply(this.#session.transferQueuedMessagesToAside as Method, this.#session, [roots]);
				const due = request.entries
					.filter(
						entry =>
							entry.intent === "immediate" &&
							this.#owns(inboxIdentity(entry)) &&
							this.#entries.get(inboxIdentity(entry))?.state !== "failed",
					)
					.map(inboxIdentity);
				if (due.length > 0 && !this.#observer.includes(due)) this.#session.agent.requestModelBoundary();
			}
		} finally {
			if (this.#barrier === barrier) this.#barrier = undefined;
			barrier.resolve();
		}
		return this.status();
	}

	#checkReceiver(receiver: InboxReceiver): void {
		const actual = this.receiver;
		if (!actual.sessionPath || actual.sessionPath !== receiver.sessionPath || actual.instance !== receiver.instance)
			throw new Error("Native inbox receiver path or incarnation changed.");
	}

	async #admit(item: Registered): Promise<void> {
		const entry = item.entry;
		const provenance = { source: INBOX_PROVENANCE_SOURCE, id: inboxIdentity(entry) };
		if (entry.kind === "report") {
			const message: CustomPrompt = {
				customType: MAIL_CUSTOM_TYPE,
				content: entry.content,
				display: true,
				attribution: "agent",
				provenance,
				details: entry.details,
			};
			if (!this.#session.isStreaming && !entry.triggerTurn) {
				await this.#session.sendCustomMessage(message, { triggerTurn: false });
				item.admitted = true;
				return;
			}
			await this.#waitForAdmission(item, callbacks =>
				this.#session.promptCustomMessage(message, {
					streamingBehavior: entry.intent === "immediate" ? "aside" : "followUp",
					...callbacks,
				}),
			);
			return;
		}
		const parts = contentParts(entry.content);
		await this.#waitForAdmission(item, callbacks =>
			this.#session.prompt(parts.text, {
				attribution: "agent",
				provenance,
				streamingBehavior: "followUp",
				expandPromptTemplates: false,
				runCommands: false,
				throwOnDrop: true,
				images: parts.images,
				...callbacks,
			}),
		);
	}

	async #waitForAdmission(
		item: Registered,
		start: (callbacks: {
			onPromptQueued(messages: readonly unknown[]): void;
			onPromptAdmitted(): void;
		}) => Promise<unknown>,
	): Promise<void> {
		const admitted = Promise.withResolvers<void>();
		let took = false;
		const run = start({
			onPromptQueued: messages => {
				item.roots = messages.filter(
					message =>
						object(message)?.role === "user" &&
						object(message)?.attribution === "agent" &&
						provenanceId(message) === inboxIdentity(item.entry),
				);
			},
			onPromptAdmitted: () => {
				took = true;
				item.admitted = true;
				admitted.resolve();
			},
		});
		void run.then(
			() => {
				if (!took) admitted.reject(new Error("Stock ended prompt setup without admitting the native entry."));
			},
			error => {
				item.state = "failed";
				item.error = String(error);
				admitted.reject(error);
			},
		);
		await admitted.promise;
	}

	#pendingRoots(authorized: ReadonlySet<string>): Map<string, unknown[]> {
		const roots = new Map<string, unknown[]>();
		for (const queue of [
			this.#session.agent.peekSteeringQueue(),
			this.#session.agent.peekFollowUpQueue(),
			this.#session.peekAsideMessages(),
		]) {
			for (const message of queue) {
				const id = provenanceId(message);
				const root = object(message);
				if (
					!id ||
					!authorized.has(id) ||
					root?.attribution !== "agent" ||
					(root.role !== "user" && (root.role !== "custom" || root.display === false))
				)
					continue;
				const group = roots.get(id);
				if (group) group.push(message);
				else roots.set(id, [message]);
			}
		}
		return roots;
	}

	#owns(id: string): boolean {
		const item = this.#entries.get(id);
		return item !== undefined && !item.entry.legacy && item.state !== "legacy_ambiguous";
	}

	#newObserver(): InboxContextObserver {
		return new InboxContextObserver({
			instance: this.receiver.instance,
			path: () => this.#session.sessionManager.getSessionFile(),
			owns: id => this.#owns(id),
			append: receipt => {
				this.#session.sessionManager.appendCustomEntry(INBOX_CONTEXT_ENTRY, receipt);
			},
		});
	}

	#present(): Set<string> {
		const ids = new Set<string>();
		for (const message of this.#session.messages) {
			const root = object(message);
			if (root?.attribution !== "agent" || (root.role !== "user" && root.role !== "custom")) continue;
			const id = provenanceId(root);
			if (id) ids.add(id);
		}
		return ids;
	}

	#journaled(): Set<string> {
		const ids = new Set<string>();
		for (const entry of this.#session.sessionManager.getBranch()) {
			const record = object(entry);
			const message = record?.type === "message" ? object(record.message) : record;
			if (
				message?.attribution !== "agent" ||
				(record?.type !== "custom_message" && (record?.type !== "message" || message.role !== "user"))
			)
				continue;
			const id = provenanceId(message);
			if (id) ids.add(id);
		}
		return ids;
	}

	#receipts(): InboxContextReceipt[] {
		const receipts: InboxContextReceipt[] = [];
		for (const entry of this.#session.sessionManager.getBranch()) {
			const record = object(entry);
			if (record?.type !== "custom" || record.customType !== INBOX_CONTEXT_ENTRY) continue;
			const value = object(record.data);
			if (
				value?.sessionPath !== this.receiver.sessionPath ||
				value.evidence !== "context-id-and-provider-output" ||
				typeof value.requestId !== "string" ||
				typeof value.instance !== "string" ||
				!Array.isArray(value.ids) ||
				!value.ids.every(id => typeof id === "string")
			)
				continue;
			const ids = value.ids.filter(id => this.#owns(id));
			if (ids.length)
				receipts.push({
					requestId: value.requestId,
					sessionPath: value.sessionPath as string,
					instance: value.instance,
					ids,
					evidence: "context-id-and-provider-output",
				});
		}
		return receipts;
	}

	#observeProvider(): void {
		const controller = this;
		const original = this.#session.agent.streamFn as Method;
		this.#session.agent.streamFn = async function (this: unknown, ...args: unknown[]) {
			const messages = object(args[1])?.messages;
			const ids = Array.isArray(messages)
				? messages.flatMap(message => {
						const id = provenanceId(message);
						return id &&
							object(message)?.attribution === "agent" &&
							controller.#owns(id) &&
							!controller.#durableInputs.has(id)
							? [id]
							: [];
					})
				: [];
			if (ids.length) {
				const receiver = controller.receiver;
				const stops = controller.#stops;
				await controller.#session.settleInFlightMessagePersistence();
				await controller.#session.sessionManager.flush();
				controller.#checkReceiver(receiver);
				if (stops !== controller.#stops) throw new Error("Receiver stopped before durable provider input.");
				const journaled = controller.#journaled();
				if (ids.some(id => !journaled.has(id)))
					throw new Error("Native provider input has no durable stock journal entry.");
				for (const id of ids) controller.#durableInputs.add(id);
			}
			const signal = object(args[2])?.signal;
			if (signal instanceof AbortSignal) signal.throwIfAborted();
			const output = controller.#observer.capture(args[1]);
			const response = await Reflect.apply(original, this, args);
			if (
				!response ||
				typeof response !== "object" ||
				!(Symbol.asyncIterator in response) ||
				typeof response[Symbol.asyncIterator] !== "function"
			)
				throw new Error("Stock provider stream is not observable.");
			const stream = response as AsyncIterable<unknown>;
			const iterator = stream[Symbol.asyncIterator];
			stream[Symbol.asyncIterator] = async function* () {
				const source: AsyncIterable<unknown> = {
					[Symbol.asyncIterator]: () => Reflect.apply(iterator, stream, []),
				};
				for await (const event of source) {
					output(event);
					yield event;
				}
			};
			return stream;
		};
	}
}
