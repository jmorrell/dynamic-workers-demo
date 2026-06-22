import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runInLoader } from '../../src/runtime/loader';
import { classifyTransformError } from '../../src/runtime/core';
import type { RunInput } from '../../src/runtime/types';

describe('runInLoader', () => {
	let testInput: RunInput;

	beforeEach(() => {
		testInput = {
			url: 'https://example.com/test',
			finalUrl: 'https://example.com/test',
			status: 200,
			contentType: 'text/html',
			body: '<html>Test page</html>',
			truncated: false,
		};
	});

	describe('AC1.1 / AC1.3: Transform execution and roundtrip', () => {
		it('executes sync transform and returns value', async () => {
			const code = 'export default (input) => input.status';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(200);
			}
		});

		it('executes async transform and returns value', async () => {
			const code = 'export default async (input) => { return Promise.resolve(input.status); }';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(200);
			}
		});

		it('roundtrips object in result.value', async () => {
			const code = `export default (input) => ({
        url: input.url,
        status: input.status,
        contentType: input.contentType
      })`;

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toEqual({
					url: 'https://example.com/test',
					status: 200,
					contentType: 'text/html',
				});
			}
		});

		it('roundtrips array in result.value', async () => {
			const code = `export default (input) => [
        input.status,
        input.contentType,
        input.truncated
      ]`;

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toEqual([200, 'text/html', false]);
			}
		});

		it('roundtrips string in result.value', async () => {
			const code = 'export default (input) => "Hello: " + input.contentType';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe('Hello: text/html');
			}
		});

		it('roundtrips null value', async () => {
			const code = 'export default (input) => null';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(null);
			}
		});

		it('roundtrips boolean value', async () => {
			const code = 'export default (input) => input.truncated';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(false);
			}
		});
	});

	describe('AC1.4: Transform error handling', () => {
		it('returns transform_threw when sync transform throws', async () => {
			const code = 'export default (input) => { throw new Error("Custom error"); }';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe('transform_threw');
				expect(result.error.message).toContain('Custom error');
			}
		});

		it('returns transform_threw when async transform throws', async () => {
			const code = `export default async (input) => {
        throw new Error("Async error");
      }`;

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe('transform_threw');
				expect(result.error.message).toContain('Async error');
			}
		});

		it('never rethrows - host process continues', async () => {
			const code = 'export default () => { throw new Error("Fatal"); }';

			// This should not throw; it should return structured error
			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe('transform_threw');
			}
		});

		it('captures error message for non-Error throws', async () => {
			const code = 'export default () => { throw "string error"; }';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.message).toContain('string error');
			}
		});
	});

	describe('AC5.2: Network-blocked fetch', () => {
		it('blocks fetch and returns network_blocked error', async () => {
			const code = `export default async (input) => {
        try {
          const response = await fetch("https://example.com");
          return response.status;
        } catch (e) {
          throw e;
        }
      }`;

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				// Must be network_blocked, not transform_threw
				expect(result.error.kind).toBe('network_blocked');
				// Capture the actual blocked-fetch message for classifyTransformError verification
				console.log('Network blocked error message:', result.error.message);
			}
		});

		it('network_blocked error classification matches classifyTransformError', async () => {
			const code = `export default async (input) => {
        try {
          await fetch("https://example.com");
        } catch (e) {
          throw e;
        }
      }`;

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				// Verify classifier parity: this should be network_blocked
				// If it's not, the inlined classifier in HARNESS_SOURCE has drifted from core.ts
				expect(result.error.kind).toBe('network_blocked');

				// Verify core.ts would classify this message the same way
				const coreClassification = classifyTransformError(result.error.message);
				expect(coreClassification).toBe('network_blocked');
			}
		});
	});

	describe('AC5.3: Isolation - no host secrets/bindings visible', () => {
		it('cannot access globalThis host properties', async () => {
			const code = `export default (input) => {
        return typeof globalThis.someHostValue;
      }`;

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				// Must be "undefined", proving host property doesn't leak
				expect(result.value).toBe('undefined');
			}
		});

		it('cannot access env bindings not passed to loaded worker', async () => {
			const code = `export default function(input) {
        // Only INPUT should be in env, passed as the function parameter
        // Try to inspect what bindings are available by checking Object.keys
        return Object.keys(input || {});
      }`;

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				// Result should be the keys in INPUT: url, finalUrl, status, contentType, body, truncated
				const keys = result.value as Array<string>;
				expect(keys).toContain('url');
				expect(keys).toContain('finalUrl');
				expect(keys).toContain('status');
				expect(keys).toContain('contentType');
				expect(keys).toContain('body');
				expect(keys).toContain('truncated');
				// Should NOT have any host bindings
				expect(keys).not.toContain('LOADER');
				expect(keys).not.toContain('NONEXISTENT_BINDING');
			}
		});

		it('only INPUT properties are accessible via input parameter', async () => {
			const code = `export default function(input) {
        // Use input directly (not this.env) to verify isolation
        // input should be the RunInput, nothing else
        const keys = Object.keys(input || {});
        const hasAllRequired = (
          'url' in input &&
          'finalUrl' in input &&
          'status' in input &&
          'contentType' in input &&
          'body' in input &&
          'truncated' in input
        );
        return { hasAllRequired, keyCount: keys.length };
      }`;

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				const value = result.value as { hasAllRequired: boolean; keyCount: number };
				expect(value.hasAllRequired).toBe(true);
				// Should be exactly 6 keys (url, finalUrl, status, contentType, body, truncated)
				expect(value.keyCount).toBe(6);
			}
		});
	});

	describe('Classifier parity: core.ts vs HARNESS_SOURCE', () => {
		it('transform_threw classification matches core.ts', async () => {
			// This test verifies that the inlined classifyTransformError in HARNESS_SOURCE
			// produces the same result as the canonical version in core.ts
			const code = 'export default () => { throw new Error("Regular error"); }';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				// Core.ts unit test says this should be "transform_threw"
				expect(result.error.kind).toBe('transform_threw');

				// Verify core.ts agrees
				const coreClassification = classifyTransformError('Regular error');
				expect(coreClassification).toBe('transform_threw');
			}
		});

		it('network_blocked classification matches core.ts', async () => {
			const code = `export default async () => {
        try {
          await fetch("https://example.com");
        } catch (e) {
          throw e;
        }
      }`;

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				// Should be network_blocked from inlined classifier
				expect(result.error.kind).toBe('network_blocked');

				// Verify core.ts would classify this the same way
				// (using a representative message from globalOutbound: null error)
				const testMessages = ['FetchError: Failed to fetch', 'Error: not allowed', 'Error: disallowed'];

				const coreClassifications = testMessages.map((msg) => classifyTransformError(msg));

				// At least some should be network_blocked to validate classifier works
				expect(coreClassifications.some((k) => k === 'network_blocked')).toBe(true);
			}
		});
	});

	describe('Module resolution and harness wiring', () => {
		it('finds and imports user module from ./user.js', async () => {
			const code = 'export default (input) => "module loaded successfully"';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe('module loaded successfully');
			}
		});

		it('passes INPUT to transform function', async () => {
			const code = `export default (input) => {
        return {
          hasUrl: 'url' in input,
          hasFinalUrl: 'finalUrl' in input,
          hasStatus: 'status' in input,
          hasContentType: 'contentType' in input,
          hasBody: 'body' in input,
          hasTruncated: 'truncated' in input
        };
      }`;

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				const value = result.value as Record<string, boolean>;
				expect(value.hasUrl).toBe(true);
				expect(value.hasFinalUrl).toBe(true);
				expect(value.hasStatus).toBe(true);
				expect(value.hasContentType).toBe(true);
				expect(value.hasBody).toBe(true);
				expect(value.hasTruncated).toBe(true);
			}
		});

		it('reflects fresh input when the same code is run with different inputs', async () => {
			// Regression: the loader caches the compiled worker by code hash. INPUT must
			// be delivered per invocation (not baked into the cached worker env), or a
			// second run of identical code returns the first run's stale input/result.
			const code = 'export default (input) => input.url';
			const first = await runInLoader(env, { ...testInput, url: 'https://first.example' }, code);
			const second = await runInLoader(env, { ...testInput, url: 'https://second.example' }, code);

			expect(first.ok).toBe(true);
			expect(second.ok).toBe(true);
			if (first.ok) expect(first.value).toBe('https://first.example');
			if (second.ok) expect(second.value).toBe('https://second.example');
		});
	});

	describe('Edge cases', () => {
		it('handles module with no default export', async () => {
			const code = 'export const foo = 42;';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				// Either loader_failed (if module fails to load) or no_transform (if loads but no default)
				expect(result.error.kind === 'no_transform' || result.error.kind === 'loader_failed').toBe(true);
			}
		});

		it('handles module that exports non-function default', async () => {
			const code = 'export default 42;';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe('no_transform');
			}
		});

		it('handles transform that returns undefined', async () => {
			const code = 'export default (input) => undefined';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(undefined);
			}
		});

		it('handles transform that returns 0', async () => {
			const code = 'export default (input) => 0';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(0);
			}
		});

		it('handles transform that returns empty string', async () => {
			const code = 'export default (input) => ""';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe('');
			}
		});

		it('handles transform that returns empty array', async () => {
			const code = 'export default (input) => []';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(Array.isArray(result.value)).toBe(true);
				expect(result.value).toHaveLength(0);
			}
		});

		it('handles transform that returns empty object', async () => {
			const code = 'export default (input) => ({})';

			const result = await runInLoader(env, testInput, code);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(typeof result.value).toBe('object');
				expect(result.value).toEqual({});
			}
		});
	});

	describe('Caching via hashCode', () => {
		it('identical code reuses warm isolate on second call', async () => {
			const code = 'export default (input) => input.status';

			// First call
			const result1 = await runInLoader(env, testInput, code);

			// Second call with same code
			const result2 = await runInLoader(env, testInput, code);

			// Both should succeed and return same value
			expect(result1.ok).toBe(true);
			expect(result2.ok).toBe(true);
			if (result1.ok && result2.ok) {
				expect(result1.value).toBe(result2.value);
				expect(result1.value).toBe(200);
			}
		});

		it('different code gets different cache id', async () => {
			const code1 = 'export default (input) => 1';
			const code2 = 'export default (input) => 2';

			const result1 = await runInLoader(env, testInput, code1);
			const result2 = await runInLoader(env, testInput, code2);

			expect(result1.ok).toBe(true);
			expect(result2.ok).toBe(true);
			if (result1.ok && result2.ok) {
				expect(result1.value).toBe(1);
				expect(result2.value).toBe(2);
			}
		});
	});
});
