import { NextResponse } from 'next/server';
import { scrapeUrl } from '@/lib/scrape';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const url = (body.url || '').trim();
    const selector = (body.selector || '').trim();

    if (!url) {
      return NextResponse.json({ error: 'URL is required.' }, { status: 400 });
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return NextResponse.json({ error: 'Invalid URL.' }, { status: 400 });
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return NextResponse.json({ error: 'Only HTTP(S) URLs are supported.' }, { status: 400 });
    }

    const content = await scrapeUrl(url, selector);
    return NextResponse.json({ content, url });
  } catch (error) {
    console.error('Scrape error:', error);
    const message = error instanceof Error ? error.message : 'Scrape failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
