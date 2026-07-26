import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { generateText, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { kimiApiKeyConfigured, runKimi } from '@/lib/kimi';
import {
  buildDocumentContext,
  composePromptWithContext,
  getContextLimits,
  loadPdfAttachments,
} from '@/lib/document-context';
import { MAX_SCRAPE_CHARS, scrapeUrl } from '@/lib/scrape';
import { formatStorageError, listStoredFiles, storeFile } from '@/lib/storage';

// Initialize Google AI with explicit API key
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY || '');
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const MAX_PROMPT_CHARS = 12_000;
const rateBucket = new Map<string, { count: number; windowStart: number }>();

async function scrapeUrlForAI(url: string, selector?: string): Promise<string> {
  try {
    return await scrapeUrl(url, selector);
  } catch (err) {
    return `Error scraping ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const SCRAPE_TOOL_DESCRIPTION =
  'Fetch and extract text content from a web page. Use this to retrieve current, real-world information from the web.';

const SYSTEM_INSTRUCTION_BASE =
  'You have access to a web scraping tool that can fetch content from any public URL. ' +
  'When answering questions that would benefit from current or real-world information — ' +
  'such as news, events, prices, documentation, product details, or any live web content — ' +
  'proactively decide which reputable websites to scrape based on the topic. ' +
  'Do NOT wait for the user to provide URLs. Choose appropriate sources yourself and scrape them to give accurate, up-to-date answers.';

const DOCUMENT_SYSTEM_ADDENDUM =
  ' The user has attached uploaded document(s). Treat the UPLOADED DOCUMENTS section in the prompt as authoritative source material. ' +
  'Answer using those documents first; cite which document you are drawing from when relevant.';

function systemInstruction(hasDocuments: boolean): string {
  return hasDocuments ? SYSTEM_INSTRUCTION_BASE + DOCUMENT_SYSTEM_ADDENDUM : SYSTEM_INSTRUCTION_BASE;
}

export const runtime = 'nodejs';
export const maxDuration = 300;

const MULTI_STEP_MAX_OUTPUT = 2048;
const KIMI_MULTI_STEP_MAX_OUTPUT = 8192;
const CLAUDE_MULTI_STEP_MAX_OUTPUT = 4096;
/** Web scrape tool enabled for debate / orchestrate / roundtable */
const MULTI_STEP_USE_TOOLS = true;

export type AIMode =
  | 'gemini'
  | 'claude'
  | 'kimi'
  | 'debate'
  | 'debate_claude_kimi'
  | 'debate_gemini_kimi'
  | 'orchestrate'
  | 'roundtable';

interface AIRequest {
  mode: AIMode;
  prompt: string;
  /** Stored file names to include as document context */
  contextFiles?: string[];
}

interface AIContextMeta {
  included: { name: string; chars: number }[];
  skipped: string[];
  pdfCount: number;
}

export async function POST(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const ip = getClientIp(request);

  try {
    const rate = checkRateLimit(ip);
    if (!rate.allowed) {
      return NextResponse.json(
        {
          error: 'Too many requests. Please try again shortly.',
          requestId,
        },
        {
          status: 429,
          headers: { 'Retry-After': String(rate.retryAfterSeconds ?? 60) },
        }
      );
    }

    let parsedBody: AIRequest;
    try {
      parsedBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body.', requestId },
        { status: 400 }
      );
    }

    const { mode, prompt } = parsedBody;
    let contextFiles = Array.isArray(parsedBody.contextFiles)
      ? parsedBody.contextFiles
          .map((n) => (typeof n === 'string' ? n.trim() : ''))
          .filter((n) => n.length > 0)
      : [];

    // If the client sent no selection, include all uploaded files so documents are never silently ignored
    if (contextFiles.length === 0) {
      const stored = await listStoredFiles();
      contextFiles = stored.map((f) => f.name);
    }
    if (
      !mode ||
      ![
        'gemini',
        'claude',
        'kimi',
        'debate',
        'debate_claude_kimi',
        'debate_gemini_kimi',
        'orchestrate',
        'roundtable',
      ].includes(mode)
    ) {
      return NextResponse.json(
        { error: 'Unsupported mode.', requestId },
        { status: 400 }
      );
    }

    if (!prompt?.trim()) {
      return NextResponse.json(
        { error: 'Prompt cannot be empty.', requestId },
        { status: 400 }
      );
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return NextResponse.json(
        { error: `Prompt is too long (max ${MAX_PROMPT_CHARS} characters).`, requestId },
        { status: 400 }
      );
    }
    if (
      (mode === 'gemini' ||
        mode === 'debate' ||
        mode === 'debate_gemini_kimi' ||
        mode === 'orchestrate' ||
        mode === 'roundtable') &&
      !process.env.GOOGLE_GENERATIVE_AI_API_KEY
    ) {
      return NextResponse.json(
        { error: 'Gemini API key is not configured.', requestId },
        { status: 500 }
      );
    }
    if (
      (mode === 'claude' ||
        mode === 'debate' ||
        mode === 'debate_claude_kimi' ||
        mode === 'orchestrate' ||
        mode === 'roundtable') &&
      !process.env.ANTHROPIC_API_KEY
    ) {
      return NextResponse.json(
        { error: 'Claude API key is not configured.', requestId },
        { status: 500 }
      );
    }
    if (
      (mode === 'kimi' ||
        mode === 'debate_claude_kimi' ||
        mode === 'debate_gemini_kimi' ||
        mode === 'roundtable' ||
        mode === 'orchestrate') &&
      !kimiApiKeyConfigured()
    ) {
      return NextResponse.json(
        { error: 'Kimi API key is not configured. Set MOONSHOT_API_KEY.', requestId },
        { status: 500 }
      );
    }

    let effectivePrompt: string;
    let contextMeta: AIContextMeta;
    try {
      ({ effectivePrompt, contextMeta } = await resolvePromptWithDocuments(
        prompt,
        contextFiles,
        mode
      ));
    } catch (docError) {
      console.error('Document context error:', docError);
      return NextResponse.json(
        {
          error:
            'Failed to read uploaded documents. Try a smaller PDF, DOCX, or TXT file.',
          requestId,
        },
        { status: 400 }
      );
    }

    if (
      contextFiles.length > 0 &&
      contextMeta.included.length === 0 &&
      contextMeta.skipped.length > 0 &&
      contextMeta.pdfCount === 0
    ) {
      return NextResponse.json(
        {
          error:
            'Could not read any selected documents. ' +
            contextMeta.skipped.join('; ') +
            ' Ensure files uploaded successfully and are PDF, DOCX, or text formats.',
          requestId,
          documentsSkipped: contextMeta.skipped,
        },
        { status: 400 }
      );
    }

    let result: string;

    switch (mode) {
      case 'gemini':
        result = await runGemini(effectivePrompt, {
          contextFiles,
          contextMeta,
          useTools: true,
          hasDocuments: contextFiles.length > 0,
        });
        break;
      case 'claude':
        result = await runClaude(effectivePrompt, true, contextFiles.length > 0);
        break;
      case 'kimi':
        result = await runKimiMode(effectivePrompt, true, contextFiles.length > 0);
        break;
      case 'debate':
        result = await runDebateGeminiClaude(effectivePrompt, contextFiles.length > 0);
        break;
      case 'debate_claude_kimi':
        result = await runDebateClaudeKimi(effectivePrompt, contextFiles.length > 0);
        break;
      case 'debate_gemini_kimi':
        result = await runDebateGeminiKimi(effectivePrompt, contextFiles.length > 0);
        break;
      case 'orchestrate':
        result = await runOrchestrate(effectivePrompt, contextFiles.length > 0);
        break;
      case 'roundtable':
        result = await runRoundtable(effectivePrompt, {
          contextFiles,
          contextMeta,
          hasDocuments: contextFiles.length > 0,
        });
        break;
      default: {
        const _exhaustiveCheck: never = mode;
        return NextResponse.json(
          { error: 'Unsupported mode.', requestId, debug: _exhaustiveCheck },
          { status: 400 }
        );
      }
    }

    // Save AI output to blob storage
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `ai-${mode}-${timestamp}.md`;
    
    const markdownContent = `# AI Output (${mode})\n\n` +
      `Time: ${new Date().toISOString()}\n\n` +
      `## Prompt\n\n${prompt}\n\n` +
      `## Result\n\n${result}\n`;

    let fileUrl: string | null = null;
    let storageWarning: string | null = null;
    try {
      const stored = await storeFile(fileName, markdownContent);
      fileUrl = `/api/download?name=${encodeURIComponent(stored.name)}`;
    } catch (storageError) {
      console.error('Blob save warning:', storageError);
      storageWarning = `AI response generated, but saving the output file failed: ${formatStorageError(storageError)}`;
    }

    const response = NextResponse.json({
      result,
      mode,
      fileName,
      fileUrl,
      storageWarning,
      requestId,
      documentsIncluded: contextMeta.included,
      documentsSkipped: contextMeta.skipped,
    });
    console.info(
      JSON.stringify({
        type: 'ai_request',
        status: 'ok',
        requestId,
        ip,
        mode,
        promptChars: prompt.length,
        durationMs: Date.now() - startedAt,
        storageSaved: Boolean(fileUrl),
      })
    );
    return response;
  } catch (error) {
    const mapped = mapProviderError(error);
    console.error(
      JSON.stringify({
        type: 'ai_request',
        status: 'error',
        requestId,
        ip,
        durationMs: Date.now() - startedAt,
        providerStatus: mapped.status,
        providerCode: mapped.code,
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return NextResponse.json(
      { error: mapped.message, requestId },
      { status: mapped.status }
    );
  }
}

async function resolvePromptWithDocuments(
  prompt: string,
  contextFiles: string[],
  mode: AIMode
): Promise<{ effectivePrompt: string; contextMeta: AIContextMeta }> {
  if (contextFiles.length === 0) {
    return {
      effectivePrompt: prompt,
      contextMeta: { included: [], skipped: [], pdfCount: 0 },
    };
  }

  const limits = getContextLimits(mode);
  const { contextBlock, skipped, included } = await buildDocumentContext(
    contextFiles,
    limits
  );
  const pdfAttachments = limits.attachPdfs
    ? await loadPdfAttachments(contextFiles)
    : [];

  const effectivePrompt = composePromptWithContext(prompt, contextBlock);
  const pdfIncluded = pdfAttachments.map((p) => ({
    name: p.name,
    chars: 0,
  }));

  return {
    effectivePrompt,
    contextMeta: {
      included: [
        ...included,
        ...pdfIncluded.filter((p) => !included.some((i) => i.name === p.name)),
      ],
      skipped,
      pdfCount: pdfAttachments.length,
    },
  };
}

interface GeminiRunOptions {
  contextFiles?: string[];
  contextMeta?: AIContextMeta;
  useTools?: boolean;
  hasDocuments?: boolean;
  attachPdfs?: boolean;
  maxOutputTokens?: number;
}

async function runGemini(
  prompt: string,
  options: GeminiRunOptions = {}
): Promise<string> {
  const {
    contextFiles = [],
    contextMeta,
    useTools = true,
    hasDocuments = false,
    attachPdfs = true,
    maxOutputTokens,
  } = options;

  const pdfAttachments =
    attachPdfs && contextMeta && contextMeta.pdfCount > 0
      ? await loadPdfAttachments(
          contextFiles.filter((n) => n.toLowerCase().endsWith('.pdf'))
        )
      : [];

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: useTools ? systemInstruction(hasDocuments) : undefined,
    generationConfig: maxOutputTokens ? { maxOutputTokens } : undefined,
    tools: useTools
      ? [
          {
            functionDeclarations: [
              {
                name: 'scrapeUrl',
                description: SCRAPE_TOOL_DESCRIPTION,
                parameters: {
                  type: SchemaType.OBJECT,
                  properties: {
                    url: { type: SchemaType.STRING, description: 'The full URL of the web page to fetch' },
                    selector: { type: SchemaType.STRING, description: 'Optional CSS selector to target specific elements' },
                  },
                  required: ['url'],
                },
              },
            ],
          },
        ]
      : undefined,
  });

  const initialParts: string | Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> =
    pdfAttachments.length > 0
      ? [
          { text: prompt },
          ...pdfAttachments.map((pdf) => ({
            inlineData: { mimeType: 'application/pdf', data: pdf.base64 },
          })),
        ]
      : prompt;

  if (!useTools) {
    const result = await model.generateContent(initialParts);
    return result.response.text();
  }

  const chat = model.startChat();
  let result = await chat.sendMessage(initialParts);
  let calls = result.response.functionCalls();

  while (calls && calls.length > 0) {
    const parts = await Promise.all(
      calls.map(async (call) => {
        const args = call.args as { url: string; selector?: string };
        return {
          functionResponse: {
            name: call.name,
            response: { content: await scrapeUrlForAI(args.url, args.selector) },
          },
        };
      })
    );
    result = await chat.sendMessage(parts);
    calls = result.response.functionCalls();
  }

  return result.response.text();
}

function collectGenerateText(result: {
  text?: string;
  steps?: Array<{ text?: string }>;
}): string {
  if (result.text?.trim()) return result.text.trim();
  const fromSteps = result.steps
    ?.map((step) => step.text)
    .filter((part) => part?.trim())
    .join('\n\n')
    .trim();
  return fromSteps || '';
}

async function runClaude(
  prompt: string,
  useTools = true,
  hasDocuments = false,
  maxTokens?: number
): Promise<string> {
  const tokenBudget = maxTokens ?? CLAUDE_MULTI_STEP_MAX_OUTPUT;
  const system = useTools
    ? systemInstruction(hasDocuments)
    : hasDocuments
      ? systemInstruction(true)
      : undefined;

  const result = await generateText({
    model: anthropic('claude-sonnet-4-6'),
    system,
    prompt,
    maxTokens: tokenBudget,
    ...(useTools
      ? {
          tools: {
            scrapeUrl: tool({
              description: SCRAPE_TOOL_DESCRIPTION,
              parameters: z.object({
                url: z.string().describe('The full URL of the web page to fetch'),
                selector: z.string().optional().describe('Optional CSS selector to target specific elements'),
              }),
              execute: async ({ url, selector }) => scrapeUrlForAI(url, selector),
            }),
          },
          maxSteps: 5,
        }
      : {}),
  });

  let text = collectGenerateText(result);
  if (!text) {
    const retry = await generateText({
      model: anthropic('claude-sonnet-4-6'),
      system,
      prompt: `${prompt}\n\nProvide your complete answer now as plain text. Do not use tools.`,
      maxTokens: tokenBudget,
    });
    text = collectGenerateText(retry);
  }

  if (!text) {
    throw new Error(
      'Claude returned an empty response. Try a shorter prompt or run Claude mode directly.'
    );
  }

  return text;
}

async function runKimiMode(
  prompt: string,
  useTools = true,
  hasDocuments = false,
  maxTokens?: number,
  reasoningEffort: 'low' | 'high' | 'max' = 'low'
): Promise<string> {
  return runKimi({
    prompt,
    system: useTools
      ? systemInstruction(hasDocuments)
      : hasDocuments
        ? systemInstruction(true)
        : undefined,
    useTools,
    maxTokens: maxTokens ?? KIMI_MULTI_STEP_MAX_OUTPUT,
    reasoningEffort,
    scrapeUrlForAI,
    scrapeToolDescription: SCRAPE_TOOL_DESCRIPTION,
  });
}

function truncateForDebate(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    '\n\n[Opponent argument truncated for length — respond to the key points above.]'
  );
}

async function runDebateGeminiClaude(
  effectivePrompt: string,
  hasDocuments: boolean
): Promise<string> {
  const geminiText = await runGemini(
    `Take a position and argue for it convincingly.\n\n${effectivePrompt}`,
    {
      useTools: MULTI_STEP_USE_TOOLS,
      hasDocuments,
      attachPdfs: false,
      maxOutputTokens: MULTI_STEP_MAX_OUTPUT,
    }
  );
  const claudeText = await runClaude(
    `You are in a debate. Gemini AI argued:\n\n${geminiText}\n\n` +
      `Now argue the opposing side or provide a strong counter-argument to Gemini's position. ` +
      `Base your answer on the uploaded documents when provided.\n\n${effectivePrompt}`,
    MULTI_STEP_USE_TOOLS,
    hasDocuments,
    CLAUDE_MULTI_STEP_MAX_OUTPUT
  );
  return `**Gemini:**\n${geminiText}\n\n**Claude:**\n${claudeText}`;
}

async function runDebateClaudeKimi(
  effectivePrompt: string,
  hasDocuments: boolean
): Promise<string> {
  const claudeText = await runClaude(
    `Take a position and argue for it convincingly.\n\n${effectivePrompt}`,
    MULTI_STEP_USE_TOOLS,
    hasDocuments,
    CLAUDE_MULTI_STEP_MAX_OUTPUT
  );
  const kimiText = await runKimiMode(
    `You are in a debate. Claude AI argued:\n\n${truncateForDebate(claudeText)}\n\n` +
      `Now argue the opposing side or provide a strong counter-argument to Claude's position. ` +
      `Base your answer on the uploaded documents when provided.\n\n${effectivePrompt}`,
    MULTI_STEP_USE_TOOLS,
    hasDocuments,
    KIMI_MULTI_STEP_MAX_OUTPUT
  );
  return `**Claude:**\n${claudeText}\n\n**Kimi K3:**\n${kimiText}`;
}

async function runDebateGeminiKimi(
  effectivePrompt: string,
  hasDocuments: boolean
): Promise<string> {
  const geminiText = await runGemini(
    `Take a position and argue for it convincingly.\n\n${effectivePrompt}`,
    {
      useTools: MULTI_STEP_USE_TOOLS,
      hasDocuments,
      attachPdfs: false,
      maxOutputTokens: MULTI_STEP_MAX_OUTPUT,
    }
  );
  const kimiText = await runKimiMode(
    `You are in a debate. Gemini AI argued:\n\n${truncateForDebate(geminiText)}\n\n` +
      `Now argue the opposing side or provide a strong counter-argument to Gemini's position. ` +
      `Base your answer on the uploaded documents when provided.\n\n${effectivePrompt}`,
    MULTI_STEP_USE_TOOLS,
    hasDocuments,
    KIMI_MULTI_STEP_MAX_OUTPUT
  );
  return `**Gemini:**\n${geminiText}\n\n**Kimi K3:**\n${kimiText}`;
}

async function runOrchestrate(
  effectivePrompt: string,
  hasDocuments: boolean
): Promise<string> {
  const planText = await runGemini(
    `Create a practical step-by-step plan.\n\n${effectivePrompt}`,
    {
      useTools: MULTI_STEP_USE_TOOLS,
      hasDocuments,
      attachPdfs: false,
      maxOutputTokens: MULTI_STEP_MAX_OUTPUT,
    }
  );
  const draft = await runClaude(
    `Execute the plan and produce a thorough response.\n\nPlan:\n${planText}\n\n${effectivePrompt}`,
    MULTI_STEP_USE_TOOLS,
    hasDocuments,
    CLAUDE_MULTI_STEP_MAX_OUTPUT
  );
  const reviewText = await runKimiMode(
    `Review this draft and suggest concrete improvements.\n\nDraft:\n${truncateForDebate(draft, 8000)}\n\n${effectivePrompt}`,
    MULTI_STEP_USE_TOOLS,
    hasDocuments,
    KIMI_MULTI_STEP_MAX_OUTPUT
  );
  const final = await runClaude(
    `Write the final polished response, incorporating the review feedback.\n\nReview:\n${reviewText}\n\n${effectivePrompt}`,
    MULTI_STEP_USE_TOOLS,
    hasDocuments,
    CLAUDE_MULTI_STEP_MAX_OUTPUT
  );
  return `**Plan (Gemini):**\n${planText}\n\n**Draft (Claude):**\n${draft}\n\n**Review (Kimi K3):**\n${reviewText}\n\n**Final (Claude):**\n${final}`;
}

async function runRoundtable(
  effectivePrompt: string,
  options: {
    contextFiles: string[];
    contextMeta: AIContextMeta;
    hasDocuments: boolean;
  }
): Promise<string> {
  const { contextFiles, contextMeta, hasDocuments } = options;
  const [geminiText, claudeText, kimiText] = await Promise.all([
    runGemini(effectivePrompt, {
      contextFiles,
      contextMeta,
      useTools: MULTI_STEP_USE_TOOLS,
      hasDocuments,
      attachPdfs: true,
      maxOutputTokens: MULTI_STEP_MAX_OUTPUT,
    }),
    runClaude(effectivePrompt, MULTI_STEP_USE_TOOLS, hasDocuments, CLAUDE_MULTI_STEP_MAX_OUTPUT),
    runKimiMode(effectivePrompt, MULTI_STEP_USE_TOOLS, hasDocuments, KIMI_MULTI_STEP_MAX_OUTPUT),
  ]);
  return (
    `**Gemini:**\n${geminiText}\n\n` +
    `**Claude:**\n${claudeText}\n\n` +
    `**Kimi K3:**\n${kimiText}`
  );
}

function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return request.headers.get('x-real-ip') || request.headers.get('cf-connecting-ip') || 'unknown';
}

function checkRateLimit(ip: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const current = rateBucket.get(ip);
  if (!current || now - current.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateBucket.set(ip, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - current.windowStart);
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }
  current.count += 1;
  rateBucket.set(ip, current);
  return { allowed: true };
}

function mapProviderError(error: unknown): { status: number; message: string; code?: string } {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes('invalid authentication') || lower.includes('invalid_authentication')) {
    return {
      status: 500,
      code: 'provider_auth',
      message: 'Kimi API key is invalid. Update MOONSHOT_API_KEY on Vercel and redeploy.',
    };
  }
  if (lower.includes('empty response')) {
    return {
      status: 502,
      code: 'provider_empty_response',
      message: msg,
    };
  }
  if (lower.includes('insufficient balance') || lower.includes('exceeded_current_quota')) {
    return {
      status: 429,
      code: 'provider_quota',
      message:
        'Kimi billing limit reached. Top up at platform.kimi.ai, then retry.',
    };
  }

  if (
    lower.includes('too many requests') ||
    lower.includes('quota exceeded') ||
    lower.includes('[429')
  ) {
    return {
      status: 429,
      code: 'provider_quota',
      message: 'AI provider rate limit reached. Wait a minute and try again.',
    };
  }
  if (lower.includes('model') && lower.includes('not found')) {
    return {
      status: 502,
      code: 'provider_model_unavailable',
      message: 'Configured model is unavailable for this API key/project.',
    };
  }
  if (lower.includes('credit balance is too low')) {
    return {
      status: 402,
      code: 'provider_insufficient_credits',
      message: 'Provider credits are insufficient. Please top up billing credits.',
    };
  }

  return {
    status: 500,
    code: 'provider_error',
    message: 'AI request failed due to provider error.',
  };
}
