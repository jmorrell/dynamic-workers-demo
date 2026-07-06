// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

// `./photon.wasm` is the photon.wasm tab of this editor — the real
// @cf-wasm/photon wasm binary (photon_rs_bg.wasm), injected by the loader the
// same way wasm-add's add.wasm is. workerd forbids compiling wasm from raw
// bytes at runtime ("Wasm code generation disallowed by embedder"), so the
// only usable path is importing a WebAssembly.Module directly and handing it
// to the glue's sync initializer — no WebAssembly.instantiate(bytes) anywhere
// in this file. `@cf-wasm/photon/others` is pure JS glue around that module
// and does not import any .wasm itself.
import photonWasm from './photon.wasm';
import { initPhoton, PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon/others';
import { parseHTML } from 'linkedom';
import type { RunInput, TransformEnv } from '../runtime/types';

const MAX_IMAGES = 4;

type ImageResult = { url: string; width: number; height: number; dhash: string } | { url: string; error: string };

export default async function transform(env: TransformEnv, input: RunInput): Promise<unknown> {
	// initPhoton throws if called twice in the same isolate; a warm Dynamic
	// Worker can invoke this transform more than once.
	if (!initPhoton.initialized) initPhoton.sync({ module: photonWasm });

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
		if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
		// photon decodes raster formats only; SVGs make its wasm panic ("unreachable").
		if (resolved.pathname.toLowerCase().endsWith('.svg')) continue;
		const normalized = resolved.toString();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		urls.push(normalized);
		if (urls.length >= MAX_IMAGES) break;
	}

	const images: ImageResult[] = [];
	for (const url of urls) {
		try {
			if (!env.fetchFile) throw new Error('env.fetchFile is unavailable');
			const file = await env.fetchFile(url);
			if (file.status < 200 || file.status >= 300) {
				images.push({ url, error: `HTTP ${file.status}` });
				continue;
			}
			if (!file.contentType.startsWith('image/') || file.contentType.startsWith('image/svg')) {
				images.push({ url, error: `skipped: ${file.contentType} (photon decodes raster images only)` });
				continue;
			}

			const image = PhotonImage.new_from_byteslice(file.bytes);
			const width = image.get_width();
			const height = image.get_height();

			// dHash: shrink to 9x8 so each row yields 8 adjacent-pixel comparisons
			// (8 cols x 8 rows = 64 bits), then compare luminance left-to-right.
			const small = resize(image, 9, 8, SamplingFilter.Triangle);
			const pixels = small.get_raw_pixels(); // RGBA, row-major, 9*8*4 bytes
			let bits = '';
			for (let row = 0; row < 8; row++) {
				const rowOffset = row * 9 * 4;
				const lum: number[] = [];
				for (let col = 0; col < 9; col++) {
					const i = rowOffset + col * 4;
					lum.push(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]);
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

			images.push({ url, width, height, dhash });
		} catch (err) {
			images.push({ url, error: err instanceof Error ? err.message : String(err) });
		}
	}

	return { images, note: 'dhash is a 64-bit perceptual difference-hash (16 hex chars); similar images produce similar hashes.' };
}
