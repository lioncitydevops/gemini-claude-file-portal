import path from 'path';
import { readStoredFile } from '@/lib/storage';

export const MAX_CHARS_PER_FILE = 30_000;
export const MAX_TOTAL_CONTEXT_CHARS = 80_000;

export interface ContextLimits {
  maxCharsPerFile: number;
  maxTotalChars: number;
  attachPdfs: boolean;
}

export function getContextLimits(mode: string): ContextLimits {
  if (mode === 'debate' || mode === 'orchestrate') {
    return { maxCharsPerFile: 12_000, maxTotalChars: 24_000, attachPdfs: false };
  }
  return {
    maxCharsPerFile: MAX_CHARS_PER_FILE,
    maxTotalChars: MAX_TOTAL_CONTEXT_CHARS,
    attachPdfs: true,
  };
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json']);

export interface DocumentContextResult {
  /** Combined text block to prepend to the user prompt */
  contextBlock: string;
  /** Files that could not be read or had no extractable text */
  skipped: string[];
  /** Per-file char counts (for logging/UI) */
  included: { name: string; chars: number }[];
}

export async function buildDocumentContext(
  fileNames: string[],
  limits: ContextLimits = {
    maxCharsPerFile: MAX_CHARS_PER_FILE,
    maxTotalChars: MAX_TOTAL_CONTEXT_CHARS,
    attachPdfs: true,
  }
): Promise<DocumentContextResult> {
  const skipped: string[] = [];
  const included: { name: string; chars: number }[] = [];
  const sections: string[] = [];
  let totalChars = 0;

  for (const name of fileNames) {
    if (totalChars >= limits.maxTotalChars) {
      skipped.push(`${name} (context budget exceeded)`);
      continue;
    }

    try {
      const { data, contentType } = await readStoredFile(name);
      const ext = path.extname(name).toLowerCase();
      const remaining = limits.maxTotalChars - totalChars;
      const perFileLimit = Math.min(limits.maxCharsPerFile, remaining);

      const text = await extractText(name, data, ext, contentType);
      const isPdf = ext === '.pdf' || contentType === 'application/pdf';
      if (!text.trim()) {
        if (isPdf) {
          skipped.push(`${name} (PDF has little/no text; Gemini still receives the PDF file when available)`);
        } else {
          skipped.push(`${name} (no extractable text)`);
        }
        continue;
      }

      const clipped = text.slice(0, perFileLimit);
      const truncated = text.length > perFileLimit;
      sections.push(
        `### ${name}\n${clipped}${truncated ? '\n\n[Document truncated due to length limit.]' : ''}`
      );
      included.push({ name, chars: clipped.length });
      totalChars += clipped.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'read failed';
      skipped.push(`${name} (${msg})`);
    }
  }

  if (sections.length === 0) {
    return { contextBlock: '', skipped, included };
  }

  const contextBlock =
    '--- UPLOADED DOCUMENTS (use as primary source for your answer) ---\n\n' +
    sections.join('\n\n') +
    '\n\n--- END UPLOADED DOCUMENTS ---\n\n';

  return { contextBlock, skipped, included };
}

async function extractText(
  name: string,
  data: Buffer,
  ext: string,
  contentType: string
): Promise<string> {
  if (ext === '.pdf' || contentType === 'application/pdf') {
    return extractPdfText(data);
  }
  if (ext === '.docx' || contentType.includes('wordprocessingml')) {
    return extractDocxText(data);
  }
  if (TEXT_EXTENSIONS.has(ext) || contentType.startsWith('text/')) {
    return data.toString('utf-8');
  }

  throw new Error(`unsupported type for text extraction (${ext || contentType})`);
}

async function extractPdfText(data: Buffer): Promise<string> {
  const loaders = [
    () => import('pdf-parse/lib/pdf-parse.js'),
    () => import('pdf-parse'),
  ];
  let lastError: unknown;
  for (const load of loaders) {
    try {
      const mod = await load();
      const pdfParse =
        (mod as { default?: (buf: Buffer) => Promise<{ text?: string }> }).default ?? mod;
      const result = await (pdfParse as (buf: Buffer) => Promise<{ text?: string }>)(data);
      const text = (result.text || '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    } catch (err) {
      lastError = err;
    }
  }
  const msg = lastError instanceof Error ? lastError.message : 'PDF parse failed';
  throw new Error(msg);
}

async function extractDocxText(data: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer: data });
  return (result.value || '').trim();
}

/** PDF buffers for Gemini native multimodal input */
export async function loadPdfAttachments(
  fileNames: string[]
): Promise<{ name: string; base64: string }[]> {
  const pdfs: { name: string; base64: string }[] = [];
  for (const name of fileNames) {
    if (path.extname(name).toLowerCase() !== '.pdf') continue;
    try {
      const { data, contentType } = await readStoredFile(name);
      if (contentType !== 'application/pdf' && !name.toLowerCase().endsWith('.pdf')) {
        continue;
      }
      pdfs.push({ name, base64: data.toString('base64') });
    } catch {
      // caller handles missing files via buildDocumentContext skipped list
    }
  }
  return pdfs;
}

export function composePromptWithContext(
  userPrompt: string,
  contextBlock: string
): string {
  if (!contextBlock.trim()) return userPrompt;
  return (
    contextBlock +
    'User question / instructions:\n' +
    userPrompt
  );
}
