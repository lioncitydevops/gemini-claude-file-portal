import { list } from '@vercel/blob';
import { NextResponse } from 'next/server';

export async function GET(): Promise<NextResponse> {
  try {
    const { blobs } = await list();
    
    const files = blobs.map(blob => ({
      name: blob.pathname,
      size: blob.size,
      url: `/api/download?name=${encodeURIComponent(blob.pathname)}`,
      uploadedAt: blob.uploadedAt,
    }));

    return NextResponse.json({ files });
  } catch (error) {
    console.error('List files error:', error);
    return NextResponse.json(
      { error: 'Failed to list files' },
      { status: 500 }
    );
  }
}
