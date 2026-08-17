import type { RunInput, TransformEnv } from '../runtime/types';

export default async function transform(
  env: TransformEnv,
  input: RunInput,
): Promise<unknown> {
  const res = await fetch(
    'https://example.com/should-be-blocked',
  );
  return { status: res.status, from: input.url };
}
