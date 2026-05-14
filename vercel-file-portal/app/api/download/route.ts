import { list } from '@vercel/blob';
import { NextResponse } from 'next/server';

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const name = (searchParams.get('name') || '').trim();
    if (!name) {
      return NextResponse.json({ error: 'Missing file name.' }, { status: 400 });
    }

    const { blobs } = await list({ prefix: name, limit: 1 });
    const blob = blobs.find((item) => item.pathname === name);
    if (!blob) {
      return NextResponse.json({ error: 'File not found.' }, { status: 404 });
    }

    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      return NextResponse.json({ error: 'Blob token is not configured.' }, { status: 500 });
    }

    const upstream = await fetch(blob.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!upstream.ok) {
      return NextResponse.json({ error: 'Unable to fetch file from storage.' }, { status: 502 });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');
    const filename = name.split('/').pop() || 'download.bin';

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        ...(contentLength ? { 'Content-Length': contentLength } : {}),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    console.error('Download error:', error);
    return NextResponse.json({ error: 'Download failed.' }, { status: 500 });
  }
}
