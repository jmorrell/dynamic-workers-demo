import type { RunInput, TransformEnv } from '../runtime/types';

const META_TAG_PATTERN = [
  String.raw`<meta\s+`,
  String.raw`(?:property|name)=["']([a-z:]+)["']\s+`,
  String.raw`content=["']([^"']*)["']`,
].join('');

const META_TAG = new RegExp(META_TAG_PATTERN, 'gi');

export default function transform(
  _env: TransformEnv,
  input: RunInput,
): unknown {
  const metadata: Record<string, string> = {};

  for (const match of input.body.matchAll(META_TAG)) {
    const [, key, value] = match;
    if (!value) continue;
    if (!key.startsWith('og:') && !key.startsWith('twitter:'))
      continue;
    metadata[key] = value;
  }

  return metadata;
}
