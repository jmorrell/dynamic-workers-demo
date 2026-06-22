import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { resolve } from "path";

export default defineWorkersConfig({
	resolve: {
		alias: {
			"@": resolve(__dirname, "./src"),
		},
	},
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
			},
		},
	},
});
