import { NextResponse } from 'next/server';
import { safeFilename, storageMode, storeFile } from '@/lib/storage';

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.csv', '.txt', '.ppt', '.pptx', '.md',
]);

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const formData = await request.formData();
    const files = formData.getAll('file') as File[];

    if (files.length === 0) {
      return NextResponse.json(
        { error: 'No files provided.' },
        { status: 400 }
      );
    }

    const uploadedFiles: string[] = [];
    const blockedFiles: string[] = [];

    for (const file of files) {
      const safeName = safeFilename(file.name);
      const ext = '.' + safeName.split('.').pop()?.toLowerCase();

      if (!ALLOWED_EXTENSIONS.has(ext)) {
        blockedFiles.push(file.name);
        continue;
      }

      await storeFile(safeName, file);
      uploadedFiles.push(safeName);
    }

    if (uploadedFiles.length === 0 && blockedFiles.length > 0) {
      return NextResponse.json(
        {
          error: `Blocked file type(s): ${blockedFiles.join(', ')}`,
          blocked: blockedFiles,
          uploaded: uploadedFiles,
          storage: storageMode(),
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      uploaded: uploadedFiles,
      blocked: blockedFiles,
      storage: storageMode(),
      message: blockedFiles.length > 0
        ? `Uploaded ${uploadedFiles.length} file(s). Blocked: ${blockedFiles.join(', ')}`
        : `Uploaded ${uploadedFiles.length} file(s).`,
    });
  } catch (error) {
    console.error('Upload error:', error);
    const message = error instanceof Error ? error.message : 'Upload failed.';
    return NextResponse.json(
      {
        error: message,
        storage: storageMode(),
        hint: storageMode() === 'local'
          ? 'Using local storage because BLOB_READ_WRITE_TOKEN is not set.'
          : 'Check Vercel Blob configuration and BLOB_STORE_ACCESS.',
      },
      { status: 500 }
    );
  }
}
