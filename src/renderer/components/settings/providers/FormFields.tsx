/**
 * Form field components: label and error display for provider configuration forms.
 */

import type { ReactNode } from "react";

export function FieldLabel({ children }: { children: ReactNode }) {
	return <span className="mb-1.5 block text-sc-sm font-medium text-(--sc-text-secondary)">{children}</span>;
}

export function FieldError({ message }: { message?: string }) {
	if (!message) return null;
	return <span className="mt-1.5 block text-sc-sm text-(--sc-danger)">{message}</span>;
}
