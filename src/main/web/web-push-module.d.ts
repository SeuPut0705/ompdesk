/** The slice of the `web-push` package (3.x, CommonJS, no bundled types) that push.ts and vapid-store.ts use. */
declare module "web-push" {
	interface WebPushSendResult {
		statusCode: number;
		body: string;
		headers: Record<string, string>;
	}

	interface WebPushSendOptions {
		TTL?: number;
		urgency?: "very-low" | "low" | "normal" | "high";
		timeout?: number;
		contentEncoding?: "aesgcm" | "aes128gcm";
		vapidDetails?: { subject: string; publicKey: string; privateKey: string };
	}

	class WebPushError extends Error {
		readonly statusCode: number;
		readonly headers: Record<string, string>;
		readonly body: string;
		readonly endpoint: string;
	}

	const webpush: {
		WebPushError: typeof WebPushError;
		generateVAPIDKeys(): { publicKey: string; privateKey: string };
		sendNotification(
			subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
			payload: string,
			options?: WebPushSendOptions,
		): Promise<WebPushSendResult>;
	};
	export default webpush;
}
