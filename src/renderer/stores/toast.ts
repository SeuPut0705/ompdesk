/**
 * Toast store: push/dismiss with auto-expiry. Rendered by
 * components/common/Toast.tsx (ToastStack).
 */

import { create } from "zustand";
import { errorDetail, errorMessage } from "../lib/error-detail";
import { reportRuntimeError } from "../lib/runtime-errors";

export type ToastVariant = "info" | "success" | "warning" | "error";

/** One follow-up the toast offers (a link-styled button); running it dismisses the toast. */
export interface ToastAction {
	label: string;
	run: () => void;
}

export interface Toast {
	id: number;
	variant: ToastVariant;
	title?: string;
	message: string;
	/** Raw technical cause (error text), shown as a quiet secondary line. */
	detail?: string;
	action?: ToastAction;
	expiresAt: number;
	count: number;
	/** Set when dismissal began; the entry lingers for the exit animation. */
	exitingAt?: number;
}

export interface ToastInput {
	variant?: ToastVariant;
	title?: string;
	message: string;
	/** Raw technical cause, kept available under the localized message (see lib/error-detail). */
	detail?: string;
	action?: ToastAction;
	/** Auto-dismiss delay in ms (default 5000). */
	durationMs?: number;
}

interface ToastStore {
	toasts: Toast[];
	/** Push a toast; returns its id. */
	push: (toast: ToastInput) => number;
	dismiss: (id: number) => void;
	/** Drop every toast whose expiry has passed. */
	pruneExpired: () => void;
}

let nextId = 1;
/** How long a dismissed toast lingers for its exit animation. */
const TOAST_EXIT_MS = 200;

export const useToastStore = create<ToastStore>()(set => ({
	toasts: [],
	push: toast => {
		const now = Date.now();
		const variant = toast.variant ?? "info";
		const expiresAt = now + (toast.durationMs ?? 5000);
		let resultId = 0;
		set(state => {
			const duplicateIndex = state.toasts.findIndex(
				entry =>
					entry.exitingAt === undefined &&
					entry.expiresAt > now &&
					entry.variant === variant &&
					entry.title === toast.title &&
					entry.message === toast.message &&
					entry.detail === toast.detail,
			);
			if (duplicateIndex >= 0) {
				const duplicate = state.toasts[duplicateIndex];
				resultId = duplicate.id;
				const merged: Toast = { ...duplicate, count: duplicate.count + 1, expiresAt };
				return {
					toasts: [...state.toasts.slice(0, duplicateIndex), ...state.toasts.slice(duplicateIndex + 1), merged],
				};
			}
			const entry: Toast = {
				id: nextId++,
				variant,
				title: toast.title,
				message: toast.message,
				...(toast.detail ? { detail: toast.detail } : {}),
				...(toast.action ? { action: toast.action } : {}),
				expiresAt,
				count: 1,
			};
			resultId = entry.id;
			return { toasts: [...state.toasts, entry].slice(-8) };
		});
		return resultId;
	},
	dismiss: id =>
		set(state => ({
			toasts: state.toasts.map(toast =>
				toast.id === id && toast.exitingAt === undefined ? { ...toast, exitingAt: Date.now() } : toast,
			),
		})),
	pruneExpired: () => {
		const now = Date.now();
		set(state => {
			// Two-phase expiry: an entry past `expiresAt` is first MARKED
			// exiting (so the stack swaps to the out-animation), then dropped
			// once the exit window passes. Without the marking pass an
			// auto-expired toast vanished with no animation at all.
			let changed = false;
			const marked = state.toasts.map(toast => {
				if (toast.exitingAt === undefined && toast.expiresAt <= now) {
					changed = true;
					return { ...toast, exitingAt: now };
				}
				return toast;
			});
			const kept = marked.filter(toast => {
				if (toast.exitingAt === undefined) return true;
				return now < toast.exitingAt + TOAST_EXIT_MS;
			});
			if (!changed && kept.length === state.toasts.length) return state;
			return { toasts: kept };
		});
	},
}));

/** Convenience helper for fire-and-forget call sites. */
export function toast(input: ToastInput): number {
	return useToastStore.getState().push(input);
}

export interface ToastErrorInput {
	/** Localized, ≤ 4 words: what failed ("Rename failed"). */
	title: string;
	/** The thrown value or the failed result (`{ error, code? }`); its raw text becomes the detail line. */
	error: unknown;
	variant?: "error" | "warning";
	durationMs?: number;
}

/**
 * Failure toast: localized title, localized one-sentence message (main's
 * coded failures get their own, see lib/error-detail), raw cause as `detail`.
 */
export function toastError({ title, error, variant = "error", durationMs }: ToastErrorInput): number {
	const detail = errorDetail(error);
	// Recorded in gui-runtime.jsonl: a toast vanishes, and "it keeps failing" needs the cause afterwards.
	reportRuntimeError("error-toast", error, { details: { title, detail } });
	return toast({ variant, title, message: errorMessage(error), detail, durationMs });
}
