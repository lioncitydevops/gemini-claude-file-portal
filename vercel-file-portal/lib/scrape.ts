export const MAX_SCRAPE_CHARS = 12_000;

export async function scrapeUrl(url: string, selector?: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }

  const html = await res.text();
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  if (selector?.trim()) {
    const classMatch = selector.match(/^\.([a-zA-Z0-9_-]+)$/);
    const idMatch = selector.match(/^#([a-zA-Z0-9_-]+)$/);
    const tagMatch = selector.match(/^([a-zA-Z0-9_-]+)$/);

    if (idMatch) {
      const match = html.match(new RegExp(`id=["']${idMatch[1]}["'][^>]*>([\\s\\S]*?)<`, 'i'));
      text = match?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || text;
    } else if (classMatch) {
      const match = html.match(
        new RegExp(`class=["'][^"']*\\b${classMatch[1]}\\b[^"']*["'][^>]*>([\\s\\S]*?)<`, 'i')
      );
      text = match?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || text;
    } else if (tagMatch) {
      const match = html.match(new RegExp(`<${tagMatch[1]}[^>]*>([\\s\\S]*?)<\\/${tagMatch[1]}>`, 'i'));
      text = match?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || text;
    }
  }

  return text.slice(0, MAX_SCRAPE_CHARS) || '(no content extracted)';
}
