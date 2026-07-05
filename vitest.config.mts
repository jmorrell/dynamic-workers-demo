import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { resolve } from 'path';

export default defineWorkersConfig({
	resolve: {
		alias: {
			'@': resolve(__dirname, './src'),
		},
	},
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				// The local workerd binary hard-errors when loading a Dynamic
				// Worker dated past its supported compat date. Override the
				// production LOADER_COMPAT_DATE var with a date the test runtime
				// can load. Production still uses the value in wrangler.jsonc.
				miniflare: {
					// Pin ENVIRONMENT to 'test' so the dev-only Turnstile bypass
					// (src/index.ts) never fires under vitest, even if .dev.vars
					// (ENVIRONMENT=development) is loaded. Gate tests stay valid.
					bindings: { LOADER_COMPAT_DATE: '2026-03-10', ENVIRONMENT: 'test' },
				},
			},
		},
	},
});
