import { NextResponse } from 'next/server';
import { deleteStoredFile } from '@/lib/storage';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { name } = await request.json();

    if (!name) {
      return NextResponse.json(
        { error: 'File name is required.' },
        { status: 400 }
      );
    }

    await deleteStoredFile(name);

    return NextResponse.json({
      message: `Deleted: ${name}`,
    });
  } catch (error) {
    console.error('Delete error:', error);
    const message = error instanceof Error ? error.message : 'Delete failed.';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
