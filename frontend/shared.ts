// pattern: Imperative Shell
//
// Page-level singletons shared by every <dynamic-workers-demo> instance on the
// page: the examples/config fetches (one network round-trip no matter how many
// embeds a post has), the anonymous store identity, and the Turnstile manager.

import { API_PREFIX } from '../src/paths';
import type { Example } from './lib/render';

// Anonymous, client-minted store identity (see src/runtime/AGENTS.md's Storage
// contract): a uuid persisted in localStorage so a storage-granted example's
// facet is found again across page loads. Embedded widgets may run without
// storage access (third-party iframe restrictions, private browsing, etc.),
// so any localStorage access is guarded — a failure falls back to a
// per-page-load-only uuid rather than breaking the run.
const STORE_ID_KEY = 'dwd-store-id';
const STORE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getOrCreateStoreId(): string {
	try {
		const existing = localStorage.getItem(STORE_ID_KEY);
		if (existing && STORE_ID_RE.test(existing)) return existing;
		const fresh = crypto.randomUUID();
		localStorage.setItem(STORE_ID_KEY, fresh);
		return fresh;
	} catch {
		// No storage access (or a write failure) — fall back to an id that's
		// stable for this page load only.
		return crypto.randomUUID();
	}
}

export const STORE_ID = getOrCreateStoreId();

// One examples fetch per page, shared across instances. A failure clears the
// cache so a later instance (or retry) can attempt again.
let examplesPromise: Promise<Array<Example>> | null = null;

export function fetchExamples(): Promise<Array<Example>> {
	if (examplesPromise) return examplesPromise;
	const promise = (async () => {
		const response = await fetch(`${API_PREFIX}/examples`);
		if (!response.ok) {
			throw new Error(`Failed to load examples: HTTP ${response.status}`);
		}
		return (await response.json()) as Array<Example>;
	})();
	promise.catch(() => {
		if (examplesPromise === promise) examplesPromise = null;
	});
	examplesPromise = promise;
	return promise;
}

// Turnstile is the only third-party script the widget touches, so it is loaded
// lazily on first interaction with any embed — a reader who never touches a
// demo loads zero third-party JS. One page-global widget serves every embed
// (tokens are page-scoped, not per-instance); it renders into the footer slot
// of whichever instance interacted first, which is where any interactive
// challenge will appear.
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

class TurnstileManager {
	private widgetId: string | null = null;
	private ready = false;
	private priming: Promise<void> | null = null;

	// Idempotent; the first caller's container wins. Safe to call from an event
	// handler on every interaction.
	prime(container: HTMLElement): void {
		if (this.priming) return;
		this.priming = this.initialize(container).catch((error) => {
			// Degrade gracefully — the server still enforces the token, so a
			// failed load surfaces as a turnstile_failed run, not a broken page.
			console.warn('Turnstile initialization failed:', error);
		});
	}

	private async initialize(container: HTMLElement): Promise<void> {
		// Fetch the sitekey and inject the script concurrently.
		const configPromise = fetch(`${API_PREFIX}/config`);

		if (!document.querySelector(`script[src="${TURNSTILE_SRC}"]`)) {
			const script = document.createElement('script');
			script.src = TURNSTILE_SRC;
			script.async = true;
			script.defer = true;
			document.head.appendChild(script);
		}

		const configResponse = await configPromise;
		if (!configResponse.ok) {
			throw new Error(`Failed to load Turnstile config: ${configResponse.statusText}`);
		}
		const config = (await configResponse.json()) as { turnstileSitekey: string };

		// The api.js script exposes no ready event, so poll for the global.
		// Bounded so a failed load degrades gracefully.
		let attempts = 0;
		const maxAttempts = 50; // ~5 seconds with 100ms intervals
		while (!window.turnstile && attempts < maxAttempts) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			attempts++;
		}
		if (!window.turnstile) {
			throw new Error('Turnstile script did not load in time');
		}

		this.widgetId = window.turnstile.render(container, {
			sitekey: config.turnstileSitekey,
			size: 'flexible',
			// Snapshot of the blog's theme (a `dark` class on <html>) at render
			// time; Turnstile offers no post-render re-theming, so a mid-session
			// toggle leaves the challenge in the old theme. Acceptable.
			theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
			'error-callback': () => {
				console.warn('Turnstile widget reported an error');
				this.ready = false;
			},
		});
		this.ready = true;
	}

	// Returns a token for a run, waiting briefly for an in-flight challenge
	// (the widget is primed on first interaction, so it usually has a token by
	// the time Run is clicked). Null when unavailable — the run proceeds
	// without a token and the server decides.
	async getToken(timeoutMs = 4000): Promise<string | null> {
		if (this.priming) await this.priming;
		if (!this.ready || !window.turnstile || this.widgetId === null) return null;

		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const token = window.turnstile.getResponse(this.widgetId);
			if (token) return token;
			if (Date.now() >= deadline || !this.ready) return null;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	// Tokens are single-use; called after each successful run submission.
	reset(): void {
		if (this.ready && window.turnstile && this.widgetId !== null) {
			window.turnstile.reset(this.widgetId);
		}
	}
}

export const turnstileManager = new TurnstileManager();
