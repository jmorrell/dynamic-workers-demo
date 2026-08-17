#!/usr/bin/env node
import path from 'path';
import {fileURLToPath} from 'url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function buildFrontend() {
	console.log('Building frontend bundle...');

	try {
		const outfile = path.resolve(repoRoot, 'public/app.js');
		const fs = await import('fs');
		fs.mkdirSync(path.dirname(outfile), { recursive: true });

		const result = await esbuild.build({
			entryPoints: [path.resolve(repoRoot, 'frontend/main.ts')],
			bundle: true,
			format: 'iife',
			outfile,
			minify: true,
			target: 'es2022',
		});

		console.log(`Frontend bundle created at ${path.relative(repoRoot, outfile)}`);
		if (result.errors.length > 0) {
			console.error('Build errors:', result.errors);
			process.exit(1);
		}
	} catch (error) {
		console.error('Frontend build failed:', error);
		process.exit(1);
	}
}

buildFrontend();
