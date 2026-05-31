import { NextResponse } from 'next/server';
import { readStoredFile } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const name = (searchParams.get('name') || '').trim();
    if (!name) {
      return NextResponse.json({ error: 'Missing file name.' }, { status: 400 });
    }

    const { data, contentType } = await readStoredFile(name);
    const filename = name.split('/').pop() || 'download.bin';

    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    console.error('Download error:', error);
    const message = error instanceof Error ? error.message : 'Download failed.';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
