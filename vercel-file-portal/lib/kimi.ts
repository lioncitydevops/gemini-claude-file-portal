import { createOpenAI } from '@ai-sdk/openai';
import { generateText, tool } from 'ai';
import { z } from 'zod';

const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_MODEL = 'kimi-k3';

export function kimiApiKeyConfigured(): boolean {
  return Boolean(process.env.MOONSHOT_API_KEY?.trim());
}

export function kimiModelId(): string {
  return process.env.MOONSHOT_MODEL?.trim() || DEFAULT_MODEL;
}

function kimiProvider() {
  const apiKey = process.env.MOONSHOT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Kimi API key is not configured.');
  }
  return createOpenAI({
    apiKey,
    baseURL: process.env.MOONSHOT_BASE_URL?.trim() || DEFAULT_BASE_URL,
  });
}

export async function runKimi(options: {
  prompt: string;
  system?: string;
  useTools?: boolean;
  maxTokens?: number;
  scrapeUrlForAI: (url: string, selector?: string) => Promise<string>;
  scrapeToolDescription: string;
}): Promise<string> {
  const { prompt, system, useTools = true, maxTokens, scrapeUrlForAI, scrapeToolDescription } =
    options;

  const { text } = await generateText({
    model: kimiProvider()(kimiModelId()),
    system,
    prompt,
    maxTokens,
    ...(useTools
      ? {
          tools: {
            scrapeUrl: tool({
              description: scrapeToolDescription,
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

  return text;
}
