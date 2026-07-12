// Ambient type declarations for the Cloudflare Turnstile widget global
// This allows window.turnstile to be accessed safely in frontend code

interface TurnstileWidget {
	/**
	 * Render the Turnstile widget on a container element
	 * @param containerId CSS selector for the container element
	 * @param options Configuration options for the widget
	 * @returns The widget ID
	 */
	render(
		containerId: string,
		options: {
			sitekey: string;
			theme?: 'light' | 'dark';
			size?: 'normal' | 'flexible' | 'compact';
			callback?: (token: string) => void;
			'error-callback'?: () => void;
		},
	): string;

	/**
	 * Get the response token from a widget
	 * @param widgetId The widget ID returned from render
	 * @returns The token or undefined if not ready
	 */
	getResponse(widgetId?: string): string | undefined;

	/**
	 * Reset a widget to allow a new challenge
	 * @param widgetId The widget ID returned from render
	 */
	reset(widgetId?: string): void;

	/**
	 * Remove a widget
	 * @param widgetId The widget ID returned from render
	 */
	remove(widgetId?: string): void;
}

declare global {
	interface Window {
		turnstile?: TurnstileWidget;
	}
}

export {};
