import OpenAI from 'openai';
import type { AppConfig } from '../types.js';

export function createOpenRouterClient(config: AppConfig): OpenAI {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: config.openrouterApiKey,
    defaultHeaders: {
      'X-Title': 'Agent Casino',
    },
  });
}
