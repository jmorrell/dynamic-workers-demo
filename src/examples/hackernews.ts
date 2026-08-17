import type { RunInput, TransformEnv } from '../runtime/types';

function stripHtml(s: string): string {
  return s
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;|&#47;/g, '/')
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(Number(code)),
    )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default function transform(
  env: TransformEnv,
  input: RunInput,
): unknown {
  const limit = 10;

  const rawUrl = input.finalUrl || input.url;
  let hostname = '';
  let itemId: string | null = null;
  try {
    const parsed = new URL(rawUrl);
    hostname = parsed.hostname;
    itemId = parsed.searchParams.get('id');
  } catch {}

  if (hostname !== 'hn.algolia.com') {
    if (hostname === 'news.ycombinator.com' && itemId) {
      const apiUrl =
        'https://hn.algolia.com/api/v1/items/' + itemId;
      throw new Error(
        'This example only works with the HN Algolia API. Use ' +
          `${apiUrl} instead`,
      );
    }
    throw new Error(
      'This example only works with the HN Algolia API ' +
        `(got ${hostname || rawUrl})`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(input.body);
  } catch {
    throw new Error(
      'This URL did not return valid JSON from the ' +
        'HN Algolia API',
    );
  }

  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as Record<string, unknown>).children)
  ) {
    throw new Error(
      'Expected an HN Algolia item URL ' +
        '(got a different Algolia API shape)',
    );
  }

  const comments: Array<{
    author: string;
    points: number | null;
    text: string;
  }> = [];

  function flatten(item: unknown): void {
    if (typeof item !== 'object' || item === null) {
      return;
    }

    const obj = item as Record<string, unknown>;

    if (typeof obj.text === 'string' && obj.text.length > 0) {
      const author = obj.author;
      const points = obj.points;

      if (typeof author === 'string' && author.length > 0) {
        comments.push({
          author,
          points:
            typeof points === 'number' || points === null
              ? points
              : null,
          text: obj.text,
        });
      }
    }

    if (Array.isArray(obj.children)) {
      for (const child of obj.children) {
        flatten(child);
      }
    }
  }

  for (const child of (data as Record<string, unknown>)
    .children as unknown[]) {
    flatten(child);
  }

  comments.sort((a, b) => {
    if (a.points === null && b.points === null) return 0;
    if (a.points === null) return 1;
    if (b.points === null) return -1;
    return b.points - a.points;
  });

  const topComments = comments.slice(0, limit);

  const storyTitle = (data as Record<string, unknown>).title;
  const heading =
    typeof storyTitle === 'string' && storyTitle.length > 0
      ? `# Top Hacker News comments on "${storyTitle}"`
      : '# Top Hacker News comments';

  const markdown = [
    heading,
    ...topComments.map((comment) => {
      const pointsLabel =
        comment.points === null
          ? ''
          : ` (${comment.points} points)`;
      return (
        `### ${comment.author}${pointsLabel}\n\n` +
        stripHtml(comment.text)
      );
    }),
  ].join('\n\n');

  return { markdown, json: { comments: topComments } };
}
