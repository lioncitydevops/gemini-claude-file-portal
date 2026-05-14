import { put } from '@vercel/blob';
import { NextResponse } from 'next/server';

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.csv', '.txt', '.ppt', '.pptx', '.md'
]);

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const formData = await request.formData();
    const files = formData.getAll('file') as File[];

    if (files.length === 0) {
      return NextResponse.json(
        { error: 'No files provided' },
        { status: 400 }
      );
    }

    const uploadedFiles: string[] = [];
    const blockedFiles: string[] = [];

    for (const file of files) {
      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        blockedFiles.push(file.name);
        continue;
      }

      const blob = await put(file.name, file, {
        // Blob SDK types only expose "public" at this version, but private stores
        // require private object access at runtime.
        access: 'private' as unknown as 'public',
        addRandomSuffix: false,
      });

      uploadedFiles.push(blob.pathname);
    }

    return NextResponse.json({
      uploaded: uploadedFiles,
      blocked: blockedFiles,
      message: blockedFiles.length > 0
        ? `Uploaded ${uploadedFiles.length} file(s). Blocked: ${blockedFiles.join(', ')}`
        : `Uploaded ${uploadedFiles.length} file(s).`,
    });
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: 'Upload failed' },
      { status: 500 }
    );
  }
}
