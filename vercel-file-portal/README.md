# Vercel File Portal

A Next.js-based document and AI portal deployed on Vercel. Features file upload/download with drag-and-drop, AI chat with Gemini and Claude (including debate and orchestrate modes), and persistent cloud storage.

## Features

- **File Management**: Upload, download, and delete documents (.pdf, .doc, .docx, .xls, .xlsx, .csv, .txt, .ppt, .pptx, .md)
- **AI Chat**: Multiple modes
  - **Gemini**: Google Gemini 1.5 Pro
  - **Claude**: Anthropic Claude 3.5 Sonnet
  - **Debate**: Gemini takes a position, Claude critiques and improves
  - **Orchestrate**: Multi-step collaborative workflow between both AIs
- **Cloud Storage**: All files and AI outputs stored in Vercel Blob
- **Chat History**: Last 20 AI interactions with downloadable Markdown outputs

## Prerequisites

- Node.js 18+ 
- Vercel account (free tier works)
- Google AI Studio API key (for Gemini)
- Anthropic API key (for Claude)

## Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Set up environment variables**:
   ```bash
   cp .env.example .env.local
   ```
   Edit `.env.local` and add your API keys:
   - `GOOGLE_GENERATIVE_AI_API_KEY` - Get from https://aistudio.google.com/app/apikey
   - `ANTHROPIC_API_KEY` - Get from https://console.anthropic.com/settings/keys

3. **Run the development server**:
   ```bash
   npm run dev
   ```

4. Open http://localhost:3000 in your browser.

## Deploy to Vercel

### One-Click Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

### Manual Deploy

1. **Push to GitHub** (if not already):
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/vercel-file-portal.git
   git push -u origin main
   ```

2. **Install Vercel CLI**:
   ```bash
   npm i -g vercel
   ```

3. **Login and deploy**:
   ```bash
   vercel login
   vercel
   ```

4. **Add environment variables** in the Vercel dashboard:
   - Go to Project Settings → Environment Variables
   - Add `GOOGLE_GENERATIVE_AI_API_KEY`
   - Add `ANTHROPIC_API_KEY`
   - Redeploy if needed

### Add Vercel Blob Storage

Files are stored using Vercel Blob. To set it up:

1. In the Vercel dashboard, go to your project
2. Click "Storage" tab → "Connect Store" → "Blob"
3. Follow the prompts to create a new Blob store
4. The connection is automatic - no additional config needed

## Project Structure

```
vercel-file-portal/
├── app/
│   ├── api/
│   │   ├── ai/           # AI processing endpoint
│   │   ├── delete/       # File deletion endpoint
│   │   ├── files/        # List files endpoint
│   │   └── upload/       # File upload endpoint
│   ├── page.tsx          # Main UI
│   ├── page.module.css   # Styles
│   └── layout.tsx        # Root layout
├── .env.example          # Environment template
├── next.config.js        # Next.js config
├── package.json          # Dependencies
└── tsconfig.json         # TypeScript config
```

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/upload` | POST | Upload files (multipart/form-data) |
| `/api/files` | GET | List all uploaded files |
| `/api/delete` | POST | Delete a file by name |
| `/api/ai` | POST | Run AI prompt |
| `/api/scrape` | POST | Scrape a public URL |
| `/api/export-docx` | POST | Export AI result as Word (.docx) |

## Differences from Original Python Version

| Feature | Python Version | Vercel Version |
|---------|---------------|----------------|
| Server | Local socket server | Next.js on Vercel Functions |
| Storage | Local filesystem | Vercel Blob (cloud) |
| AI Calls | CLI subprocess | Vercel AI SDK |
| Scaling | Single instance | Auto-scaling serverless |
| Access | Local only | Global edge network |

## Troubleshooting

### "AI request failed" errors
- Check that your API keys are set correctly in Vercel dashboard
- Verify the keys have not expired
- Check Vercel Functions logs for detailed error messages

### File upload issues
- Ensure Vercel Blob is connected in your project, or rely on local fallback storage (`.upload-storage/`) when `BLOB_READ_WRITE_TOKEN` is unset
- If using a private Blob store, set `BLOB_STORE_ACCESS=private`
- Check that file size is under the limit (4.5MB for Hobby plan)
- Verify file extension is in the allowed list

### Build errors
- Make sure all dependencies are installed: `npm install`
- Check Node.js version is 18+
- Clear `.next` folder and rebuild: `rm -rf .next && npm run build`

## License

MIT
