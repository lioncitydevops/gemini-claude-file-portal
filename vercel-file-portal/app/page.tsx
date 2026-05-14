'use client';

import { useState, useEffect, useCallback } from 'react';
import styles from './page.module.css';

interface FileItem {
  name: string;
  size: number;
  url: string;
  uploadedAt: string;
}

interface HistoryItem {
  time: string;
  mode: string;
  promptPreview: string;
  fileName: string;
  fileUrl: string | null;
}

type AIMode = 'gemini' | 'claude' | 'debate' | 'orchestrate';

export default function Home() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [uploadMessage, setUploadMessage] = useState('');
  const [uploadError, setUploadError] = useState(false);
  const [aiMode, setAiMode] = useState<AIMode>('debate');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiResult, setAiResult] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [scrapeEnabled, setScrapeEnabled] = useState(false);
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [scrapeSelector, setScrapeSelector] = useState('');
  const [scrapeContent, setScrapeContent] = useState('');
  const [scrapeLoading, setScrapeLoading] = useState(false);
  const [scrapeError, setScrapeError] = useState(false);

  const fetchFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/files');
      const data = await res.json();
      setFiles(data.files || []);
    } catch (err) {
      console.error('Failed to fetch files:', err);
    }
  }, []);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedFiles(e.target.files);
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFiles || selectedFiles.length === 0) {
      setUploadMessage('No files selected');
      setUploadError(true);
      return;
    }

    const formData = new FormData();
    for (const file of selectedFiles) {
      formData.append('file', file);
    }

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();

      if (res.ok) {
        setUploadMessage(data.message);
        setUploadError(data.blocked?.length > 0 && data.uploaded?.length === 0);
        setSelectedFiles(null);
        fetchFiles();
      } else {
        setUploadMessage(data.error || 'Upload failed');
        setUploadError(true);
      }
    } catch {
      setUploadMessage('Upload failed');
      setUploadError(true);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm('Delete this file?')) return;

    try {
      const res = await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      if (res.ok) {
        setUploadMessage(`Deleted: ${name}`);
        setUploadError(false);
        fetchFiles();
      } else {
        setUploadMessage('Delete failed');
        setUploadError(true);
      }
    } catch {
      setUploadMessage('Delete failed');
      setUploadError(true);
    }
  };

  const handleScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scrapeUrl.trim()) return;
    setScrapeLoading(true);
    setScrapeContent('');
    setScrapeError(false);
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: scrapeUrl, selector: scrapeSelector }),
      });
      const data = await res.json();
      if (res.ok) {
        setScrapeContent(data.content || '(no content extracted)');
        setScrapeError(false);
      } else {
        setScrapeContent(data.error || 'Scrape failed');
        setScrapeError(true);
      }
    } catch (err) {
      setScrapeContent(err instanceof Error ? err.message : 'Scrape failed');
      setScrapeError(true);
    } finally {
      setScrapeLoading(false);
    }
  };

  const handleAI = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiPrompt.trim()) {
      setAiResult('Prompt cannot be empty');
      setAiError(true);
      return;
    }

    setAiLoading(true);
    setAiResult('');
    setAiError(false);

    try {
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: aiMode, prompt: aiPrompt }),
      });

      const data = await res.json();

      if (res.ok) {
        const finalResult = data.storageWarning
          ? `${data.result}\n\n[Storage warning] ${data.storageWarning}`
          : data.result;
        setAiResult(finalResult);
        setAiError(false);

        // Add to history
        const newEntry: HistoryItem = {
          time: new Date().toLocaleString(),
          mode: data.mode,
          promptPreview: aiPrompt.length > 80 ? aiPrompt.slice(0, 80) + '...' : aiPrompt,
          fileName: data.fileName,
          fileUrl: data.fileUrl,
        };
        setHistory(prev => [...prev, newEntry].slice(-20));
      } else {
        setAiResult(data.error || 'AI request failed');
        setAiError(true);
      }
    } catch (err) {
      setAiResult(err instanceof Error ? err.message : 'AI request failed');
      setAiError(true);
    } finally {
      setAiLoading(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setSelectedFiles(e.dataTransfer.files);
    }
  };

  const fileCountText = selectedFiles
    ? `${selectedFiles.length} file(s) selected`
    : 'No files selected';

  return (
    <main className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>Document + AI Portal</h1>
        <p className={styles.meta}>
          Allowed extensions: .pdf, .doc, .docx, .xls, .xlsx, .csv, .txt, .ppt, .pptx, .md
        </p>

        {uploadMessage && (
          <p className={uploadError ? styles.error : styles.ok}>{uploadMessage}</p>
        )}

        <form onSubmit={handleUpload}>
          <div
            className={`${styles.dropzone} ${isDragging ? styles.dragover : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            Drag and drop files here, or use file picker
          </div>
          <input
            type="file"
            multiple
            onChange={handleFileChange}
            className={styles.fileInput}
          />
          <p className={styles.meta}>{fileCountText}</p>
          <button type="submit" className={styles.button} disabled={!selectedFiles}>
            Upload
          </button>
        </form>

        <h2 className={styles.sectionTitle}>
          Web Scraper
          <button
            type="button"
            className={scrapeEnabled ? styles.toggleOn : styles.toggleOff}
            onClick={() => setScrapeEnabled(v => !v)}
            aria-pressed={scrapeEnabled}
          >
            {scrapeEnabled ? 'ON' : 'OFF'}
          </button>
        </h2>

        {scrapeEnabled && (
          <>
            <p className={styles.meta}>Fetch and extract text from any public URL, then send it to AI.</p>
            <form onSubmit={handleScrape}>
              <label className={styles.label} htmlFor="scrapeUrl">URL</label>
              <input
                id="scrapeUrl"
                type="url"
                value={scrapeUrl}
                onChange={(e) => setScrapeUrl(e.target.value)}
                className={styles.inputText}
                placeholder="https://example.com"
                required
              />
              <label className={styles.label} htmlFor="scrapeSelector">
                CSS Selector <span className={styles.meta}>(optional — e.g. article, .content, h1)</span>
              </label>
              <input
                id="scrapeSelector"
                type="text"
                value={scrapeSelector}
                onChange={(e) => setScrapeSelector(e.target.value)}
                className={styles.inputText}
                placeholder="Leave blank to extract all body text"
              />
              <button type="submit" className={styles.button} disabled={scrapeLoading} style={{ marginTop: '1rem' }}>
                {scrapeLoading ? 'Scraping...' : 'Scrape'}
              </button>
            </form>

            {scrapeContent && (
              <div className={styles.aiResult}>
                <p className={scrapeError ? styles.error : styles.ok}>
                  {scrapeError ? 'Error' : `Scraped: ${scrapeUrl}`}
                </p>
                <pre className={styles.resultPre}>{scrapeContent}</pre>
                {!scrapeError && (
                  <button
                    type="button"
                    className={styles.button}
                    style={{ marginTop: '0.75rem' }}
                    onClick={() => setAiPrompt(scrapeContent)}
                  >
                    Use as AI Prompt
                  </button>
                )}
              </div>
            )}
          </>
        )}

        <h2 className={styles.sectionTitle}>AI Prompt</h2>
        <form onSubmit={handleAI}>
          <label htmlFor="mode" className={styles.label}>Mode</label>
          <select
            id="mode"
            value={aiMode}
            onChange={(e) => setAiMode(e.target.value as AIMode)}
            className={styles.select}
          >
            <option value="gemini">Gemini</option>
            <option value="claude">Claude</option>
            <option value="debate">Gemini vs Claude (debate)</option>
            <option value="orchestrate">Orchestrate</option>
          </select>

          <textarea
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            rows={6}
            className={styles.textarea}
            placeholder="Enter your prompt here..."
            required
          />

          <button type="submit" className={styles.button} disabled={aiLoading}>
            {aiLoading ? 'Processing...' : 'Run AI'}
          </button>
        </form>

        {aiResult && (
          <div className={styles.aiResult}>
            <h3>AI Result</h3>
            <p className={aiError ? styles.error : styles.ok}>Mode: {aiMode}</p>
            <pre className={styles.resultPre}>{aiResult}</pre>
          </div>
        )}

        <h2 className={styles.sectionTitle}>Chat History</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Time</th>
              <th>Mode</th>
              <th>Prompt</th>
              <th>Output</th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 ? (
              <tr>
                <td colSpan={4}>No AI runs yet.</td>
              </tr>
            ) : (
              history.map((entry, i) => (
                <tr key={i}>
                  <td>{entry.time}</td>
                  <td>{entry.mode}</td>
                  <td>{entry.promptPreview}</td>
                  <td>
                    {entry.fileUrl ? (
                      <a href={entry.fileUrl} download>
                        Download .md
                      </a>
                    ) : (
                      <span>No file link</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <h2 className={styles.sectionTitle}>Available Files</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {files.length === 0 ? (
              <tr>
                <td colSpan={3}>No files uploaded yet.</td>
              </tr>
            ) : (
              files.map((file) => (
                <tr key={file.name}>
                  <td>{file.name}</td>
                  <td>{formatSize(file.size)}</td>
                  <td>
                    <a href={file.url} download>Download</a>
                    {' '}
                    <button
                      onClick={() => handleDelete(file.name)}
                      className={styles.deleteButton}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
