// pattern: Imperative Shell

export type VerifyResult = { ok: boolean; errorCodes: Array<string> };

export async function verifyTurnstile(
	token: string | undefined,
	secret: string,
	remoteIp: string | undefined,
	fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
	if (!token) return { ok: false, errorCodes: ['missing-input-response'] };

	const body = new FormData();
	body.append('secret', secret);
	body.append('response', token);
	if (remoteIp) body.append('remoteip', remoteIp);

	const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
	const data = (await res.json()) as { success: boolean; 'error-codes'?: Array<string> };

	return { ok: data.success === true, errorCodes: data['error-codes'] ?? [] };
}
