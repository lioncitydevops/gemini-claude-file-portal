import { del, get, list, put } from '@vercel/blob';
import fs from 'fs/promises';
import path from 'path';

export interface StoredFile {
  name: string;
  size: number;
  uploadedAt: string;
}

const LOCAL_STORAGE_DIR = path.join(process.cwd(), '.upload-storage');

function useBlobStorage(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

type BlobAccess = 'public' | 'private';

function getBlobAccess(): BlobAccess {
  const configured = process.env.BLOB_STORE_ACCESS?.trim().toLowerCase();
  if (configured === 'public' || configured === 'private') {
    return configured;
  }
  // New Vercel Blob stores default to private; prefer that unless explicitly public.
  return 'private';
}

function blobAccessMismatch(message: string): 'public' | 'private' | null {
  const lower = message.toLowerCase();
  if (lower.includes('private store') && lower.includes('public access')) {
    return 'private';
  }
  if (lower.includes('public store') && lower.includes('private access')) {
    return 'public';
  }
  return null;
}

async function putBlob(name: string, data: Buffer | Blob | string) {
  let access = getBlobAccess();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await put(name, data, {
        access,
        addRandomSuffix: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback = blobAccessMismatch(message);
      if (fallback && fallback !== access && attempt === 0) {
        access = fallback;
        continue;
      }
      throw error;
    }
  }
  throw new Error('Blob upload failed.');
}

export function safeFilename(rawName: string): string {
  const base = path.basename(rawName.trim()).replace(/[/\\]/g, '_');
  return base || 'uploaded_file';
}

export function isUserUpload(name: string): boolean {
  return !/^ai-[a-z]+-.+\.md$/i.test(name);
}

async function ensureLocalDir(): Promise<void> {
  await fs.mkdir(LOCAL_STORAGE_DIR, { recursive: true });
}

async function localPath(name: string): Promise<string> {
  await ensureLocalDir();
  const resolved = path.resolve(LOCAL_STORAGE_DIR, name);
  if (!resolved.startsWith(path.resolve(LOCAL_STORAGE_DIR))) {
    throw new Error('Invalid file path.');
  }
  return resolved;
}

export async function storeFile(name: string, data: Buffer | Blob | string): Promise<StoredFile> {
  if (useBlobStorage()) {
    const blob = await putBlob(name, data);
    const size =
      typeof data === 'string'
        ? Buffer.byteLength(data, 'utf-8')
        : data instanceof Blob
          ? data.size
          : data.length;
    return {
      name: blob.pathname,
      size,
      uploadedAt: new Date().toISOString(),
    };
  }

  const filePath = await localPath(name);
  const buffer =
    typeof data === 'string'
      ? Buffer.from(data, 'utf-8')
      : data instanceof Blob
        ? Buffer.from(await data.arrayBuffer())
        : data;
  await fs.writeFile(filePath, buffer);
  const stat = await fs.stat(filePath);
  return {
    name,
    size: stat.size,
    uploadedAt: stat.mtime.toISOString(),
  };
}

export async function listStoredFiles(): Promise<StoredFile[]> {
  if (useBlobStorage()) {
    const { blobs } = await list();
    return blobs
      .filter((blob) => isUserUpload(blob.pathname))
      .map((blob) => ({
        name: blob.pathname,
        size: blob.size,
        uploadedAt: blob.uploadedAt.toISOString(),
      }));
  }

  await ensureLocalDir();
  const entries = await fs.readdir(LOCAL_STORAGE_DIR, { withFileTypes: true });
  const files: StoredFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isUserUpload(entry.name)) continue;
    const stat = await fs.stat(path.join(LOCAL_STORAGE_DIR, entry.name));
    files.push({
      name: entry.name,
      size: stat.size,
      uploadedAt: stat.mtime.toISOString(),
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteStoredFile(name: string): Promise<void> {
  if (useBlobStorage()) {
    await del(name);
    return;
  }

  const filePath = await localPath(name);
  await fs.unlink(filePath);
}

export async function readStoredFile(name: string): Promise<{ data: Buffer; contentType: string }> {
  if (useBlobStorage()) {
    const access = getBlobAccess();
    try {
      const response = await get(name, { access });
      if (!response || response.statusCode === 304 || !response.stream) {
        throw new Error('File not found.');
      }
      const data = Buffer.from(await new Response(response.stream).arrayBuffer());
      const contentType = response.blob.contentType || guessContentType(name);
      return { data, contentType };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback = blobAccessMismatch(message);
      if (fallback && fallback !== access) {
        const response = await get(name, { access: fallback });
        if (!response || response.statusCode === 304 || !response.stream) {
          throw new Error('File not found.');
        }
        const data = Buffer.from(await new Response(response.stream).arrayBuffer());
        const contentType = response.blob.contentType || guessContentType(name);
        return { data, contentType };
      }
      throw error;
    }
  }

  const filePath = await localPath(name);
  try {
    const data = await fs.readFile(filePath);
    return { data, contentType: guessContentType(name) };
  } catch {
    throw new Error('File not found.');
  }
}

function guessContentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.json': 'application/json',
  };
  return map[ext] || 'application/octet-stream';
}

export function storageMode(): 'blob' | 'local' {
  return useBlobStorage() ? 'blob' : 'local';
}

export function formatStorageError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Storage operation failed.';
  const lower = message.toLowerCase();
  if (lower.includes('private store') && lower.includes('public access')) {
    return 'Blob store is private; set BLOB_STORE_ACCESS=private and redeploy.';
  }
  if (lower.includes('public store') && lower.includes('private access')) {
    return 'Blob store is public; set BLOB_STORE_ACCESS=public and redeploy.';
  }
  return message;
}
