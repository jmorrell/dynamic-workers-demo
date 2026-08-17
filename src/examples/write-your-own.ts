import type { RunInput, TransformEnv } from '../runtime/types';

export default function transform(
  env: TransformEnv,
  input: RunInput,
): unknown {
  const linkedUrls = [...(env.resources?.keys() ?? [])];

  console.log(
    `Received ${input.finalUrl} with ${linkedUrls.length} linked resources`,
  );

  return {
    json: {
      url: input.finalUrl,
      status: input.status,
      contentType: input.contentType,
      linkedUrls: linkedUrls.slice(0, 10),
      databaseSize: env.DB?.databaseSize ?? null,
    },
  };
}
