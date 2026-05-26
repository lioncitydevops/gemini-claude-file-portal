import { NextResponse } from 'next/server';
import { listStoredFiles, storageMode } from '@/lib/storage';

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
      { error: 'Failed to list files.' },
      { status: 500 }
    );
  }
}
