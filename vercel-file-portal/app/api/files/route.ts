import { NextResponse } from 'next/server';
import { formatStorageError, listStoredFiles, storageMode } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const files = await listStoredFiles();
    return NextResponse.json({
      files: files.map((file) => ({
        name: file.name,
        size: file.size,
        url: `/api/download?name=${encodeURIComponent(file.name)}`,
        uploadedAt: file.uploadedAt,
      })),
      storage: storageMode(),
    });
  } catch (error) {
    console.error('List files error:', error);
    return NextResponse.json(
      { error: formatStorageError(error), storage: storageMode() },
      { status: 500 }
    );
  }
}
