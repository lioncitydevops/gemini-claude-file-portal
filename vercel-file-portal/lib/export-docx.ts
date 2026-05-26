import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';

function paragraphFromText(text: string, bold = false): Paragraph[] {
  const lines = text.split(/\r?\n/);
  return lines.map(
    (line) =>
      new Paragraph({
        children: [new TextRun({ text: line || ' ', bold })],
      })
  );
}

export async function buildAiResultDocx(options: {
  mode: string;
  prompt: string;
  result: string;
}): Promise<Buffer> {
  const { mode, prompt, result } = options;
  const timestamp = new Date().toLocaleString();

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: `AI Output (${mode})`,
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph({
            children: [
              new TextRun({ text: 'Generated: ', bold: true }),
              new TextRun(timestamp),
            ],
          }),
          new Paragraph({ text: '' }),
          new Paragraph({
            text: 'Prompt',
            heading: HeadingLevel.HEADING_2,
          }),
          ...paragraphFromText(prompt),
          new Paragraph({ text: '' }),
          new Paragraph({
            text: 'Result',
            heading: HeadingLevel.HEADING_2,
          }),
          ...paragraphFromText(result),
        ],
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
