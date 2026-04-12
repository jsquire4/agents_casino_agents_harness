import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { CasinoClient } from './api/casino-client.js';
import { createTransport } from './transport/factory.js';
import { createOpenRouterClient } from './llm/openrouter.js';
import { loadProfile, loadCredentials, saveCredentials } from './personality/store.js';
import { AgentLoop } from './agent/agent-loop.js';

async function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string', short: 'p' },
      room: { type: 'string', short: 'r', default: 'casino_low_1' },
      'buy-in': { type: 'string', short: 'b', default: '20000' },
      poll: { type: 'string', default: '' },
    },
  });

  const profileId = values.profile;
  if (!profileId) {
    console.error('Usage: npx tsx src/agent.ts --profile <agent_id> [--room <room_id>] [--buy-in <amount>]');
    console.error('\nCreate a profile first: npx tsx src/personality/creator.ts');
    process.exit(1);
  }

  const roomId = values.room!;
  const buyIn = parseInt(values['buy-in']!, 10);

  // Load config and profile
  const config = loadConfig();
  if (values.poll) {
    config.pollIntervalMs = parseInt(values.poll, 10);
  }
  const profile = await loadProfile(profileId);

  // Load or create credentials
  let creds = await loadCredentials(profileId);
  if (!creds) {
    console.log(`Registering new agent: ${profile.nickname}...`);
    const result = await CasinoClient.register(config, profileId, profile.nickname);
    creds = { agentId: result.agentId, secretKey: result.secretKey };
    await saveCredentials(profileId, creds);
    console.log(`Registered: ${profile.nickname} (${creds.agentId})`);
  }

  // Build components
  const client = new CasinoClient(config, creds.agentId, creds.secretKey);
  const transport = createTransport(config, client, creds.secretKey);
  const llm = createOpenRouterClient(config);

  // Claim chips if needed
  try {
    const balance = await client.getBalance();
    if (balance < buyIn) {
      const msg = await client.claim();
      console.log(`Chips: ${msg}`);
    }
  } catch {
    try {
      const msg = await client.claim();
      console.log(`Chips: ${msg}`);
    } catch { /* cooldown, proceed anyway */ }
  }

  // Create and start agent loop
  const loop = new AgentLoop(transport, llm, profile, {
    agentId: creds.agentId,
    roomId,
    buyIn,
    appConfig: config,
    client,
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await loop.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', async (err) => {
    console.error('Unhandled rejection:', err);
    await loop.stop();
    process.exit(1);
  });

  // Start playing
  await loop.start();

  console.log(`\n🎰 ${profile.nickname} is playing at ${roomId}`);
  console.log(`   Watch: https://agentcasino-production.up.railway.app?watch=${creds.agentId}`);
  console.log('   Press Ctrl+C to stop\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
