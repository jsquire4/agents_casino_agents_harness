import type { AppConfig } from '../types.js';
import type { ITransport } from './transport.js';
import { CasinoClient } from '../api/casino-client.js';
import { RestTransport } from './rest-transport.js';
import { WebSocketTransport } from './ws-transport.js';

export function createTransport(
  config: AppConfig,
  client: CasinoClient,
  secretKey: string,
): ITransport {
  if (config.transportType === 'ws') {
    if (!config.wsUrl) {
      throw new Error('WS_URL is required when TRANSPORT_TYPE=ws');
    }
    return new WebSocketTransport(config.wsUrl, client, secretKey);
  }
  return new RestTransport(client, config.pollIntervalMs);
}
