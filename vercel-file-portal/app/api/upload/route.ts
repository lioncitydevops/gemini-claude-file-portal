import path from 'path';
import { NextResponse } from 'next/server';
import {
  formatStorageError,
  safeFilename,
  storageMode,
  storeFile,
  toStorageBuffer,
} from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.csv', '.txt', '.ppt', '.pptx', '.md',
]);

// Vercel serverless request body limit is 4.5 MB; stay under to avoid HTML 413 pages
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

function isUploadFile(entry: FormDataEntryValue): entry is File {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'arrayBuffer' in entry &&
    typeof (entry as File).arrayBuffer === 'function'
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const formData = await request.formData();
    const files = formData
      .getAll('file')
      .filter(isUploadFile)
      .filter((file) => file.size > 0);

    if (files.length === 0) {
      return NextResponse.json(
        { error: 'No files provided. Choose a file and click Upload.' },
        { status: 400 }
      );
    }

    const uploadedFiles: string[] = [];
    const blockedFiles: string[] = [];
    const oversizedFiles: string[] = [];

    for (const file of files) {
      const safeName = safeFilename(file.name || 'uploaded_file');
      const ext = path.extname(safeName).toLowerCase();

      if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
        blockedFiles.push(file.name || safeName);
        continue;
      }

      if (file.size > MAX_UPLOAD_BYTES) {
        oversizedFiles.push(file.name || safeName);
        continue;
      }

      const buffer = await toStorageBuffer(file);
      await storeFile(safeName, buffer);
      uploadedFiles.push(safeName);
    }

    if (uploadedFiles.length === 0) {
      const reasons: string[] = [];
      if (blockedFiles.length > 0) {
        reasons.push(`Blocked type(s): ${blockedFiles.join(', ')}`);
      }
      if (oversizedFiles.length > 0) {
        reasons.push(`Too large (max 4 MB): ${oversizedFiles.join(', ')}`);
      }
      return NextResponse.json(
        {
          error: reasons.join(' ') || 'No files could be uploaded.',
          blocked: blockedFiles,
          oversized: oversizedFiles,
          uploaded: uploadedFiles,
          storage: storageMode(),
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      uploaded: uploadedFiles,
      blocked: blockedFiles,
      oversized: oversizedFiles,
      storage: storageMode(),
      message: [
        `Uploaded ${uploadedFiles.length} file(s).`,
        blockedFiles.length > 0 ? `Blocked: ${blockedFiles.join(', ')}` : '',
        oversizedFiles.length > 0 ? `Too large: ${oversizedFiles.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    });
  } catch (error) {
    console.error('Upload error:', error);
    const message = formatStorageError(error);
    return NextResponse.json(
      {
        error: message,
        storage: storageMode(),
        hint:
          storageMode() === 'local'
            ? 'Using local storage because BLOB_READ_WRITE_TOKEN is not set. On Vercel production, connect Vercel Blob so uploads persist.'
            : 'Check Vercel Blob configuration and BLOB_STORE_ACCESS (private vs public).',
      },
      { status: 500 }
    );
  }
}
