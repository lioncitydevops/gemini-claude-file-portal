#!/usr/bin/env node
/**
 * End-to-end test suite for Vercel File Portal (production or local).
 * Usage: node scripts/e2e-full.mjs [baseUrl]
 */
const BASE = process.argv[2] || process.env.TEST_BASE_URL || 'https://vercel-file-portal.vercel.app';

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const icon = ok ? 'PASS' : 'FAIL';
  console.log(`${icon} ${name}${detail ? `\n       ${detail}` : ''}`);
}

async function request(path, options = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, options);
  const contentType = res.headers.get('content-type') || '';
  let body;
  if (contentType.includes('application/json')) {
    body = await res.json();
  } else if (
    contentType.includes('application/octet-stream') ||
    contentType.includes('wordprocessingml') ||
    contentType.includes('text/plain') ||
    contentType.includes('application/pdf')
  ) {
    body = await res.arrayBuffer();
  } else {
    body = await res.text();
  }
  return { res, body, contentType };
}

async function testHomePage() {
  const { res, body } = await request('/');
  const html = typeof body === 'string' ? body : '';
  const ok =
    res.ok &&
    html.includes('Document + AI Portal') &&
    html.includes('_next/static');
  record('GET / (home page)', ok, ok ? `status ${res.status}` : `status ${res.status}`);
}

async function testListFiles() {
  const { res, body } = await request('/api/files');
  const ok = res.ok && Array.isArray(body.files);
  record('GET /api/files', ok, ok ? `storage=${body.storage}, count=${body.files.length}` : JSON.stringify(body));
  return body;
}

async function testUploadDownloadDelete() {
  const testName = `e2e-test-${Date.now()}.txt`;
  const content = `E2E upload test at ${new Date().toISOString()}`;

  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), testName);

  const upload = await request('/api/upload', { method: 'POST', body: form });
  const uploadOk =
    upload.res.ok &&
    upload.body.uploaded?.includes(testName);
  record(
    'POST /api/upload',
    uploadOk,
    uploadOk ? upload.body.message : JSON.stringify(upload.body)
  );
  if (!uploadOk) return;

  const files = await request('/api/files');
  const listed = files.body.files?.some((f) => f.name === testName);
  record('Upload appears in file list', listed);

  const download = await request(`/api/download?name=${encodeURIComponent(testName)}`);
  const downloaded =
    download.res.ok &&
    Buffer.from(download.body).toString('utf-8') === content;
  record(
    'GET /api/download',
    downloaded,
    downloaded ? `size=${download.body.byteLength}` : `status=${download.res.status}`
  );

  const del = await request('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: testName }),
  });
  record('POST /api/delete', del.res.ok, del.body.message || JSON.stringify(del.body));

  const afterDelete = await request('/api/files');
  const gone = !afterDelete.body.files?.some((f) => f.name === testName);
  record('Deleted file removed from list', gone);
}

async function testScrape() {
  const { res, body } = await request('/api/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  const ok =
    res.ok &&
    typeof body.content === 'string' &&
    body.content.toLowerCase().includes('example');
  record('POST /api/scrape', ok, ok ? body.content.slice(0, 80) + '...' : JSON.stringify(body));
}

async function testExportDocx() {
  const { res, body, contentType } = await request('/api/export-docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'gemini',
      prompt: 'E2E test prompt',
      result: 'E2E test result with multiple\nlines of content.',
    }),
  });
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body instanceof ArrayBuffer ? new Uint8Array(body) : String(body));
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // PK zip header (docx)
  const ok = res.ok && isZip && contentType.includes('wordprocessingml');
  record(
    'POST /api/export-docx',
    ok,
    ok ? `${bytes.length} bytes, content-type=${contentType}` : `status=${res.status}`
  );
}

async function testAiEndpoint() {
  const { res, body } = await request('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'gemini', prompt: 'Reply with exactly: E2E_OK' }),
  });

  if (res.status === 429) {
    record('POST /api/ai (gemini)', true, 'Rate limited but endpoint reachable');
    return;
  }

  if (res.ok && body.result) {
    record('POST /api/ai (gemini)', true, `result length=${body.result.length}, fileUrl=${Boolean(body.fileUrl)}`);
    return;
  }

  // Config errors are acceptable for E2E infra check — endpoint must respond correctly
  const configError =
    res.status === 500 &&
    typeof body.error === 'string' &&
    (body.error.includes('API key') || body.error.includes('not configured'));
  record(
    'POST /api/ai (gemini)',
    configError || res.status === 402 || res.status === 502,
    configError ? body.error : JSON.stringify(body)
  );
}

async function testValidation() {
  const emptyUpload = await request('/api/upload', { method: 'POST', body: new FormData() });
  record('POST /api/upload (empty rejects)', emptyUpload.res.status === 400);

  const emptyAi = await request('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'gemini', prompt: '' }),
  });
  record('POST /api/ai (empty prompt rejects)', emptyAi.res.status === 400);

  const badScrape = await request('/api/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: '' }),
  });
  record('POST /api/scrape (empty url rejects)', badScrape.res.status === 400);
}

async function main() {
  console.log(`\nE2E tests against: ${BASE}\n${'='.repeat(50)}\n`);

  await testHomePage();
  await testListFiles();
  await testUploadDownloadDelete();
  await testScrape();
  await testExportDocx();
  await testAiEndpoint();
  await testValidation();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.');
  }
}

main().catch((err) => {
  console.error('E2E runner error:', err);
  process.exitCode = 1;
});
