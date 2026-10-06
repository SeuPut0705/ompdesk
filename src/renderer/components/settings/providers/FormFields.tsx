/**
 * Form field components: label and error display for provider configuration forms.
 */

import type { ReactNode } from "react";

export function FieldLabel({ children }: { children: ReactNode }) {
	return <span className="mb-1 block text-omp-sm font-medium tracking-wide text-(--omp-muted)">{children}</span>;
}

export function FieldError({ message }: { message?: string }) {
	if (!message) return null;
	return <span className="mt-1 block text-omp-sm text-(--omp-error)">{message}</span>;
}
