// NOTE: Example payload (untrusted code). Not application code — executed via the loader.

// The sandbox loads WebAssembly modules natively. `./add.wasm` is the module in
// the add.wasm tab of this editor — 41 bytes of real wasm. Its source (WAT):
//
//   (module
//     (func (export "add") (param i32 i32) (result i32)
//       local.get 0
//       local.get 1
//       i32.add))
//
import addModule from './add.wasm';
import type { RunInput, TransformEnv } from '../runtime/types';

export default async function transform(env: TransformEnv, input: RunInput): Promise<unknown> {
	const { exports } = await WebAssembly.instantiate(addModule);
	const add = exports.add as (a: number, b: number) => number;
	const a = Math.floor(Math.random() * 1000);
	const b = input.body.length;
	return { a, b, 'a + b (computed in wasm)': add(a, b) };
}
