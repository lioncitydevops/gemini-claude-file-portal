import { NextResponse } from 'next/server';
import { buildAiResultDocx } from '@/lib/export-docx';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const mode = (body.mode || 'ai').trim();
    const prompt = (body.prompt || '').trim();
    const result = (body.result || '').trim();

    if (!result) {
      return NextResponse.json({ error: 'Result text is required.' }, { status: 400 });
    }

    const docx = await buildAiResultDocx({ mode, prompt, result });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `ai-${mode}-${timestamp}.docx`;

    return new NextResponse(new Uint8Array(docx), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Export docx error:', error);
    const message = error instanceof Error ? error.message : 'Word export failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
