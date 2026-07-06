import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchTarget } from '../../src/runtime/fetch-target';
import { RunInput } from '../../src/runtime/types';

describe('fetchTarget', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('URL validation', () => {
		it('rejects invalid URLs', async () => {
			const result = await fetchTarget('not a url');
			expect(result.type).toBe('failure');
			if (result.type === 'failure') {
				expect(result.error.kind).toBe('fetch_failed');
				expect(result.error.message).toContain('invalid');
			}
		});

		it('rejects relative URLs', async () => {
			const result = await fetchTarget('/path/to/page');
			expect(result.type).toBe('failure');
		});

		describe('SSRF guard', () => {
			it.each([
				'http://localhost/secret',
				'http://127.0.0.1/secret',
				'http://10.0.0.1/secret',
				'http://[::1]/secret',
				'http://169.254.169.254/latest/meta-data',
			])('rejects %s with fetch_failed and never calls fetch', async (url) => {
				const fetchMock = vi.fn();
				vi.stubGlobal('fetch', fetchMock);

				const result = await fetchTarget(url);

				expect(result.type).toBe('failure');
				if (result.type === 'failure') {
					expect(result.error.kind).toBe('fetch_failed');
					expect(result.error.message).toContain('blocked host');
				}
				expect(fetchMock).not.toHaveBeenCalled();
			});

			it('fails a redirect that lands on a private address after the fetch resolves', async () => {
				const fetchMock = vi.fn(() => {
					const response = new Response('internal', {
						status: 200,
						headers: { 'content-type': 'text/plain' },
					});
					Object.defineProperty(response, 'url', {
						value: 'http://169.254.169.254/latest/meta-data',
						writable: false,
					});
					return Promise.resolve(response);
				});
				vi.stubGlobal('fetch', fetchMock);

				const result = await fetchTarget('https://example.com/redirects-away');

				expect(fetchMock).toHaveBeenCalled();
				expect(result.type).toBe('failure');
				if (result.type === 'failure') {
					expect(result.error.kind).toBe('fetch_failed');
					expect(result.error.message).toContain('blocked host');
				}
			});
		});

		it('accepts http URLs', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn(() =>
					Promise.resolve(
						new Response('test body', {
							status: 200,
							headers: { 'content-type': 'text/plain' },
						}),
					),
				),
			);

			const result = await fetchTarget('http://example.com/page');
			expect(result.type).toBe('success');
		});

		it('accepts https URLs', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn(() =>
					Promise.resolve(
						new Response('test body', {
							status: 200,
							headers: { 'content-type': 'text/plain' },
						}),
					),
				),
			);

			const result = await fetchTarget('https://example.com/page');
			expect(result.type).toBe('success');
		});
	});

	describe('successful fetch', () => {
		it('returns input with url, finalUrl, status, contentType, body, truncated', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn(() =>
					Promise.resolve(
						new Response('Hello World', {
							status: 200,
							headers: { 'content-type': 'text/html; charset=utf-8' },
						}),
					),
				),
			);

			const result = await fetchTarget('https://example.com/test');

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				const input = result.input;
				expect(input.url).toBe('https://example.com/test');
				expect(input.status).toBe(200);
				expect(input.contentType).toBe('text/html; charset=utf-8');
				expect(input.body).toBe('Hello World');
				expect(input.truncated).toBe(false);
				expect(input.finalUrl).toBeDefined();
			}
		});

		it('captures finalUrl from response.url', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn(() => {
					const response = new Response('content', {
						status: 200,
						headers: { 'content-type': 'text/plain' },
					});
					// Mock the url property on response
					Object.defineProperty(response, 'url', {
						value: 'https://example.com/final',
						writable: false,
					});
					return Promise.resolve(response);
				}),
			);

			const result = await fetchTarget('https://example.com/original');

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.input.finalUrl).toBe('https://example.com/final');
			}
		});

		it('sets truncated true when body exceeds maxBytes', async () => {
			const largeBody = 'x'.repeat(3 * 1024 * 1024); // 3MiB, exceeds 2MiB default
			vi.stubGlobal(
				'fetch',
				vi.fn(() =>
					Promise.resolve(
						new Response(largeBody, {
							status: 200,
							headers: { 'content-type': 'text/plain' },
						}),
					),
				),
			);

			const result = await fetchTarget('https://example.com/large');

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.input.truncated).toBe(true);
				expect(result.input.body.length).toBeLessThanOrEqual(2 * 1024 * 1024);
			}
		});

		it('respects content-type charset parameter', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn(() =>
					Promise.resolve(
						new Response('Test', {
							status: 200,
							headers: { 'content-type': 'application/json; charset=utf-8' },
						}),
					),
				),
			);

			const result = await fetchTarget('https://example.com/json');

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.input.contentType).toBe('application/json; charset=utf-8');
			}
		});
	});

	describe('fetch failure scenarios', () => {
		it('returns fetch_failed when response.ok is false (non-2xx)', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn(() =>
					Promise.resolve(
						new Response('Not Found', {
							status: 404,
							headers: { 'content-type': 'text/plain' },
						}),
					),
				),
			);

			const result = await fetchTarget('https://example.com/notfound');

			expect(result.type).toBe('failure');
			if (result.type === 'failure') {
				expect(result.error.kind).toBe('fetch_failed');
				expect(result.error.message).toContain('404');
			}
		});

		it('returns fetch_failed on network error', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn(() => Promise.reject(new Error('Network error'))),
			);

			const result = await fetchTarget('https://unreachable.example.com');

			expect(result.type).toBe('failure');
			if (result.type === 'failure') {
				expect(result.error.kind).toBe('fetch_failed');
			}
		});

		it('returns fetch_failed when mock rejects with timeout', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn(() => Promise.reject(new Error('Timeout'))),
			);

			const result = await fetchTarget('https://slow.example.com');

			expect(result.type).toBe('failure');
			if (result.type === 'failure') {
				expect(result.error.kind).toBe('fetch_failed');
			}
		});

		it('aborts fetch after timeout via AbortController', async () => {
			// Mock fetch to be intercepted by AbortSignal
			let abortSignal: AbortSignal | undefined;
			const fetchMock = vi.fn((url: string, init?: RequestInit) => {
				abortSignal = init?.signal;
				// Listen for abort and reject when it happens
				if (abortSignal) {
					return new Promise((_, reject) => {
						abortSignal!.addEventListener('abort', () => {
							reject(new Error('The user aborted a request.'));
						});
					});
				}
				// Fallback that never settles (but shouldn't happen)
				return new Promise(() => {});
			});

			vi.stubGlobal('fetch', fetchMock);

			// Use a short timeout so the test completes quickly
			const result = await fetchTarget('https://slow.example.com', {
				timeoutMs: 50,
			});

			// Should fail due to abort
			expect(result.type).toBe('failure');
			if (result.type === 'failure') {
				expect(result.error.kind).toBe('fetch_failed');
				// Verify fetch was called with an abort signal
				expect(fetchMock).toHaveBeenCalled();
			}
		});

		it('returns fetch_failed on 500 error', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn(() =>
					Promise.resolve(
						new Response('Internal Server Error', {
							status: 500,
							headers: { 'content-type': 'text/plain' },
						}),
					),
				),
			);

			const result = await fetchTarget('https://example.com/error');

			expect(result.type).toBe('failure');
			if (result.type === 'failure') {
				expect(result.error.kind).toBe('fetch_failed');
			}
		});
	});

	describe('text encoding', () => {
		it('reads response as UTF-8 text', async () => {
			const utf8Text = 'Hello 世界 🌍';
			vi.stubGlobal(
				'fetch',
				vi.fn(() =>
					Promise.resolve(
						new Response(utf8Text, {
							status: 200,
							headers: { 'content-type': 'text/plain; charset=utf-8' },
						}),
					),
				),
			);

			const result = await fetchTarget('https://example.com/utf8');

			expect(result.type).toBe('success');
			if (result.type === 'success') {
				expect(result.input.body).toBe(utf8Text);
			}
		});
	});

	describe('timeout behavior', () => {
		it('sets a timeout for the fetch operation', async () => {
			const fetchMock = vi.fn(() =>
				Promise.resolve(
					new Response('quick', {
						status: 200,
						headers: { 'content-type': 'text/plain' },
					}),
				),
			);
			vi.stubGlobal('fetch', fetchMock);

			await fetchTarget('https://example.com/fast');

			expect(fetchMock).toHaveBeenCalled();
			const callArgs = fetchMock.mock.calls[0];
			expect(callArgs).toHaveLength(2);
			const options = callArgs[1] as { signal?: AbortSignal };
			expect(options.signal).toBeDefined();
		});
	});
});
