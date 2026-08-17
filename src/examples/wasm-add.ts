import addModule from './add.wasm';
import type { RunInput, TransformEnv } from '../runtime/types';

export default async function transform(
  env: TransformEnv,
  input: RunInput,
): Promise<unknown> {
  const { exports } = await WebAssembly.instantiate(addModule);
  const add = exports.add as (a: number, b: number) => number;
  const a = Math.floor(Math.random() * 1000);
  const b = input.body.length;
  return { a, b, 'a + b (computed in wasm)': add(a, b) };
}
