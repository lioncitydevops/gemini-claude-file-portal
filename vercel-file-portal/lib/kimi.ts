const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_MODEL = 'kimi-k3';
const MAX_TOOL_STEPS = 5;

type KimiRole = 'system' | 'user' | 'assistant' | 'tool';

interface KimiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface KimiMessage {
  role: KimiRole;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: KimiToolCall[];
  tool_call_id?: string;
}

interface KimiToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function kimiApiKeyConfigured(): boolean {
  return Boolean(process.env.MOONSHOT_API_KEY?.trim());
}

export function kimiModelId(): string {
  return process.env.MOONSHOT_MODEL?.trim() || DEFAULT_MODEL;
}

function kimiBaseUrl(): string {
  return process.env.MOONSHOT_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

function kimiApiKey(): string {
  const apiKey = process.env.MOONSHOT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Kimi API key is not configured.');
  }
  return apiKey;
}

async function kimiCompletion(
  messages: KimiMessage[],
  options: {
    tools?: KimiToolDef[];
    maxCompletionTokens?: number;
    reasoningEffort?: 'low' | 'high' | 'max';
  }
): Promise<KimiMessage> {
  const res = await fetch(`${kimiBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${kimiApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: kimiModelId(),
      messages,
      reasoning_effort: options.reasoningEffort ?? 'low',
      ...(options.tools?.length ? { tools: options.tools, tool_choice: 'auto' } : {}),
      ...(options.maxCompletionTokens
        ? { max_completion_tokens: options.maxCompletionTokens }
        : {}),
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(raw || `Kimi API HTTP ${res.status}`);
  }

  const data = JSON.parse(raw) as {
    choices?: Array<{ message?: KimiMessage }>;
  };
  const message = data.choices?.[0]?.message;
  if (!message) {
    throw new Error('Kimi API returned no message.');
  }
  return message;
}

function scrapeToolDef(description: string): KimiToolDef {
  return {
    type: 'function',
    function: {
      name: 'scrapeUrl',
      description,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL of the web page to fetch' },
          selector: {
            type: 'string',
            description: 'Optional CSS selector to target specific elements',
          },
        },
        required: ['url'],
      },
    },
  };
}

function extractKimiText(message: KimiMessage): string {
  return (message.content || '').trim();
}

export async function runKimi(options: {
  prompt: string;
  system?: string;
  useTools?: boolean;
  maxTokens?: number;
  reasoningEffort?: 'low' | 'high' | 'max';
  scrapeUrlForAI: (url: string, selector?: string) => Promise<string>;
  scrapeToolDescription: string;
}): Promise<string> {
  const {
    prompt,
    system,
    useTools = true,
    maxTokens,
    reasoningEffort = 'low',
    scrapeUrlForAI,
    scrapeToolDescription,
  } = options;

  const messages: KimiMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const tools = useTools ? [scrapeToolDef(scrapeToolDescription)] : undefined;
  const completionBudget = maxTokens ?? 4096;

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const message = await kimiCompletion(messages, {
      tools,
      maxCompletionTokens: completionBudget,
      reasoningEffort,
    });

    messages.push(message);

    const toolCalls = message.tool_calls ?? [];
    if (!toolCalls.length) {
      const text = extractKimiText(message);
      if (text) return text;

      // Kimi K3 may spend the token budget on reasoning and return empty content.
      messages.push({
        role: 'user',
        content: 'Provide your final answer now as plain text. Do not use tools.',
      });
      const retry = await kimiCompletion(messages, {
        tools: undefined,
        maxCompletionTokens: Math.max(completionBudget, 8192),
        reasoningEffort: 'low',
      });
      messages.push(retry);
      const retryText = extractKimiText(retry);
      if (retryText) return retryText;

      throw new Error(
        'Kimi API returned an empty response. Try a shorter prompt or switch to Kimi K3 solo mode.'
      );
    }

    for (const call of toolCalls) {
      if (call.function.name !== 'scrapeUrl') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Unknown tool: ${call.function.name}`,
        });
        continue;
      }

      let args: { url?: string; selector?: string } = {};
      try {
        args = JSON.parse(call.function.arguments || '{}') as { url?: string; selector?: string };
      } catch {
        args = {};
      }

      const url = args.url?.trim();
      const content = url
        ? await scrapeUrlForAI(url, args.selector)
        : 'Error: scrapeUrl requires a url argument.';

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content,
      });
    }
  }

  throw new Error('Kimi tool loop exceeded maximum steps.');
}
