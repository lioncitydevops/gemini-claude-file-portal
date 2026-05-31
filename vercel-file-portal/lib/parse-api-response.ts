/** Parse API responses safely when Vercel/Next returns HTML or plain text on errors. */
export async function readApiJson<T extends Record<string, unknown>>(
  res: Response
): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    return { error: serverErrorMessage(res.status) } as unknown as T;
  }

  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(text) as T;
    } catch {
      // fall through to friendly message
    }
  }

  const plain = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

  return {
    error: serverErrorMessage(res.status, plain),
  } as unknown as T;
}

function serverErrorMessage(status: number, detail?: string): string {
  if (status === 413) {
    return 'File is too large. Maximum upload size is 4 MB on Vercel.';
  }
  if (status === 502 || status === 504) {
    return (
      'Request timed out or the server was unavailable. Try a shorter prompt, ' +
      'fewer documents, or Gemini/Claude mode instead of Debate/Orchestrate.'
    );
  }
  if (status === 429) {
    return 'Too many requests. Please wait a moment and try again.';
  }
  if (detail && !detail.toLowerCase().startsWith('an error occurred')) {
    return detail;
  }
  if (detail) {
    return `Server error (${status}). ${detail}`;
  }
  return `Server error (${status}). Please try again.`;
}
