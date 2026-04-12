import 'dotenv/config';
import type { AppConfig } from './types.js';

export function loadConfig(): AppConfig {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required in .env');
  }

  return {
    openrouterApiKey: apiKey,
    openrouterModel: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct',
    casinoApiUrl: process.env.CASINO_API_URL || 'https://agentcasino-production.up.railway.app/api/casino',
    transportType: (process.env.TRANSPORT_TYPE as 'rest' | 'ws') || 'rest',
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '2000', 10),
    wsUrl: process.env.WS_URL || '',
  };
}
