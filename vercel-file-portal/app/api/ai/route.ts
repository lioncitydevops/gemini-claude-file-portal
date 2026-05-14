import { GoogleGenerativeAI } from '@google/generative-ai';
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { put } from '@vercel/blob';
import { NextResponse } from 'next/server';

// Initialize Google AI with explicit API key
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY || '');
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const MAX_PROMPT_CHARS = 12_000;
const rateBucket = new Map<string, { count: number; windowStart: number }>();

export type AIMode = 'gemini' | 'claude' | 'debate' | 'orchestrate';

interface AIRequest {
  mode: AIMode;
  prompt: string;
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
    if (!mode || !['gemini', 'claude', 'debate', 'orchestrate'].includes(mode)) {
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
    if ((mode === 'gemini' || mode === 'debate' || mode === 'orchestrate') && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      return NextResponse.json(
        { error: 'Gemini API key is not configured.', requestId },
        { status: 500 }
      );
    }
    if ((mode === 'claude' || mode === 'debate' || mode === 'orchestrate') && !process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: 'Claude API key is not configured.', requestId },
        { status: 500 }
      );
    }

    let result: string;

    switch (mode) {
      case 'gemini':
        result = await runGemini(prompt);
        break;
      case 'claude':
        result = await runClaude(prompt);
        break;
      case 'debate':
        result = await runDebate(prompt);
        break;
      case 'orchestrate':
        result = await runOrchestrate(prompt);
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
      const blob = await put(fileName, markdownContent, {
        // Blob SDK types only expose "public" at this version, but private stores
        // require private object access at runtime.
        access: 'private' as unknown as 'public',
        addRandomSuffix: false,
      });
      fileUrl = `/api/download?name=${encodeURIComponent(blob.pathname)}`;
    } catch (storageError) {
      console.error('Blob save warning:', storageError);
      storageWarning = 'AI response generated, but saving output file failed.';
    }

    const response = NextResponse.json({
      result,
      mode,
      fileName,
      fileUrl,
      storageWarning,
      requestId,
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

async function runGemini(prompt: string): Promise<string> {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(prompt);
  const response = await result.response;
  return response.text();
}

async function runClaude(prompt: string): Promise<string> {
  const { text } = await generateText({
    model: anthropic('claude-sonnet-4-6'),
    prompt,
  });
  return text;
}

async function runDebate(prompt: string): Promise<string> {
  // Gemini takes a position
  const geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const geminiResult = await geminiModel.generateContent(`Take a position and justify: ${prompt}`);
  const geminiResponse = await geminiResult.response;
  const geminiText = geminiResponse.text();

  // Claude critiques and improves
  const claudeResponse = await generateText({
    model: anthropic('claude-sonnet-4-6'),
    prompt: `Critique and improve this response:\n${geminiText}`,
  });

  return `**Gemini:**\n${geminiText}\n\n**Claude:**\n${claudeResponse.text}`;
}

async function runOrchestrate(prompt: string): Promise<string> {
  const geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  // Step 1: Gemini creates a plan
  const planResult = await geminiModel.generateContent(`Create a practical plan: ${prompt}`);
  const planText = (await planResult.response).text();

  // Step 2: Claude executes the plan
  const draft = await generateText({
    model: anthropic('claude-sonnet-4-6'),
    prompt: `Execute this plan:\n${planText}`,
  });

  // Step 3: Gemini reviews
  const reviewResult = await geminiModel.generateContent(`Review and improve:\n${draft.text}`);
  const reviewText = (await reviewResult.response).text();

  // Step 4: Claude produces final answer
  const final = await generateText({
    model: anthropic('claude-sonnet-4-6'),
    prompt: `Produce final answer:\n${reviewText}`,
  });

  return `**Plan:**\n${planText}\n\n` +
    `**Draft:**\n${draft.text}\n\n` +
    `**Review:**\n${reviewText}\n\n` +
    `**Final:**\n${final.text}`;
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

  if (lower.includes('too many requests') || lower.includes('quota exceeded') || lower.includes('[429')) {
    return {
      status: 429,
      code: 'provider_quota',
      message: 'Provider quota/rate limit reached. Please retry shortly or check provider billing/quota.',
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
