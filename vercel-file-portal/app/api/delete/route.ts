import { del } from '@vercel/blob';
import { NextResponse } from 'next/server';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { name } = await request.json();

    if (!name) {
      return NextResponse.json(
        { error: 'File name is required' },
        { status: 400 }
      );
    }

    await del(name);

    return NextResponse.json({
      message: `Deleted: ${name}`,
    });
  } catch (error) {
    console.error('Delete error:', error);
    return NextResponse.json(
      { error: 'Delete failed' },
      { status: 500 }
    );
  }
}
