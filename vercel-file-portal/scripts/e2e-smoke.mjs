#!/usr/bin/env node
/**
 * Lightweight API smoke test for local storage mode (no Vercel Blob token required).
 * Run from vercel-file-portal after: npm install && npm run dev
 */
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json() : await res.text();
  return { res, body };
}

async function main() {
  const checks = [];

  const files = await request('/api/files');
  checks.push(['GET /api/files', files.res.ok, files.body]);

  const scrape = await request('/api/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  checks.push(['POST /api/scrape', scrape.res.ok && scrape.body.content, scrape.body]);

  const form = new FormData();
  form.append('file', new Blob(['hello upload test'], { type: 'text/plain' }), 'e2e-test.txt');
  const upload = await request('/api/upload', { method: 'POST', body: form });
  checks.push(['POST /api/upload', upload.res.ok, upload.body]);

  if (upload.res.ok && upload.body.uploaded?.length) {
    const name = upload.body.uploaded[0];
    const download = await request(`/api/download?name=${encodeURIComponent(name)}`);
    checks.push(['GET /api/download', download.res.ok, typeof download.body === 'string']);

    const del = await request('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    checks.push(['POST /api/delete', del.res.ok, del.body]);
  }

  const exportDoc = await request('/api/export-docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'gemini',
      prompt: 'Test prompt',
      result: 'Test result body',
    }),
  });
  checks.push([
    'POST /api/export-docx',
    exportDoc.res.ok && exportDoc.body.length > 100,
    exportDoc.res.headers.get('content-type'),
  ]);

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) {
      failed += 1;
      console.log('  ', detail);
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
    console.error(`\n${failed} check(s) failed.`);
  } else {
    console.log('\nAll checks passed.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
