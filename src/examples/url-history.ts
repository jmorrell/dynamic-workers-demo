import type { RunInput, TransformEnv } from '../runtime/types';

export default function transform(
  env: TransformEnv,
  input: RunInput,
): unknown {
  const DB = env.DB;
  if (!DB) throw new Error('env.DB is unavailable');

  DB.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL
    )
  `);

  DB.exec('INSERT INTO submissions (url) VALUES (?)', input.url);
  console.log(`Added ${input.url}`);

  const urls = DB.exec<{ url: string }>(
    'SELECT url FROM submissions ORDER BY id',
  ).toArray().map((row) => row.url);

  console.log(`Returning ${urls.length} submitted URLs`);

  return { urls };
}
