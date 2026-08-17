import photonWasm from './photon.wasm';
import {
  initPhoton,
  PhotonImage,
  resize,
  SamplingFilter,
} from '@cf-wasm/photon/others';
import { parseHTML } from 'linkedom';
import type { RunInput, TransformEnv } from '../runtime/types';

const MAX_IMAGES = 4;

type ImageResult =
  | { url: string; width: number; height: number; dhash: string }
  | { url: string; error: string };

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export default async function transform(
  env: TransformEnv,
  input: RunInput,
): Promise<unknown> {
  if (!initPhoton.initialized)
    initPhoton.sync({ module: photonWasm });

  const { document } = parseHTML(input.body);
  const base = input.finalUrl || input.url;

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const el of document.querySelectorAll('img[src]')) {
    const src = el.getAttribute('src');
    if (!src) continue;
    let resolved: URL;
    try {
      resolved = new URL(src, base);
    } catch {
      continue;
    }
    if (
      resolved.protocol !== 'http:' &&
      resolved.protocol !== 'https:'
    )
      continue;
    if (resolved.pathname.toLowerCase().endsWith('.svg'))
      continue;
    const normalized = resolved.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
    if (urls.length >= MAX_IMAGES) break;
  }

  console.log(
    `Found ${urls.length} raster image candidates` +
      (urls.length >= MAX_IMAGES ? ` (limit ${MAX_IMAGES})` : ''),
  );

  const images: ImageResult[] = [];
  for (const url of urls) {
    try {
      console.log(`Reading image ${displayUrl(url)}`);
      const resource = env.resources?.get(url);
      if (!resource) {
        throw new Error(
          `No resource capability was granted for ${url}`,
        );
      }
      const file = await resource.read();
      if (file.kind !== 'bytes') {
        throw new Error(
          `Expected a binary resource for ${url}, got ${file.contentType}`,
        );
      }
      if (file.status < 200 || file.status >= 300) {
        console.log(
          `Image read failed with HTTP ${file.status}: ${displayUrl(url)}`,
        );
        images.push({ url, error: `HTTP ${file.status}` });
        continue;
      }
      if (
        !file.contentType.startsWith('image/') ||
        file.contentType.startsWith('image/svg')
      ) {
        console.log(
          `Skipping ${displayUrl(url)}: unsupported ${file.contentType}`,
        );
        images.push({
          url,
          error:
            `skipped: ${file.contentType} ` +
            '(photon decodes raster images only)',
        });
        continue;
      }

      const image = PhotonImage.new_from_byteslice(file.bytes);
      const width = image.get_width();
      const height = image.get_height();

      const small = resize(image, 9, 8, SamplingFilter.Triangle);
      const pixels = small.get_raw_pixels();
      let bits = '';
      for (let row = 0; row < 8; row++) {
        const rowOffset = row * 9 * 4;
        const lum: number[] = [];
        for (let col = 0; col < 9; col++) {
          const i = rowOffset + col * 4;
          lum.push(
            0.299 * pixels[i] +
              0.587 * pixels[i + 1] +
              0.114 * pixels[i + 2],
          );
        }
        for (let col = 0; col < 8; col++) {
          bits += lum[col] > lum[col + 1] ? '1' : '0';
        }
      }
      const dhash = bits
        .match(/.{4}/g)!
        .map((nibble) => parseInt(nibble, 2).toString(16))
        .join('');

      image.free();
      small.free();

      console.log(
        `Hashed ${displayUrl(url)}: ${width}×${height}, dHash ${dhash}`,
      );
      images.push({ url, width, height, dhash });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `Could not hash ${displayUrl(url)}: ${message}`,
      );
      images.push({
        url,
        error: message,
      });
    }
  }

  const failedImages = images.filter(
    (image) => 'error' in image,
  ).length;
  console.log(
    `Finished: ${images.length - failedImages} images hashed, ${failedImages} failed or skipped`,
  );

  return {
    images,
    note:
      'dhash is a 64-bit perceptual difference-hash ' +
      '(16 hex chars); ' +
      'similar images produce similar hashes.',
  };
}
