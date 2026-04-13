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
      'warrant-retries': { type: 'string', default: '3' },
    },
  });

  const profileId = values.profile;
  if (!profileId) {
    console.error('Usage: npx tsx src/agent.ts --profile <agent_id> [--room <room_id>] [--buy-in <amount>] [--warrant-retries <n>]');
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

  // Ensure we have enough chips before joining
  try {
    const balance = await client.getBalance();
    if (balance < buyIn) {
      await client.claim();
    }
  } catch {
    try { await client.claim(); } catch { /* cooldown — proceed with what we have */ }
  }

  // If still short, buy in with what we have
  const finalBalance = await client.getBalance().catch(() => 0);
  const effectiveBuyIn = finalBalance >= buyIn ? buyIn : Math.max(finalBalance, 0);

  // Create and start agent loop
  const actualBuyIn = effectiveBuyIn > 0 ? effectiveBuyIn : buyIn;
  const loop = new AgentLoop(transport, llm, profile, {
    agentId: creds.agentId,
    roomId,
    buyIn: actualBuyIn,
    appConfig: config,
    client,
    warrantMaxRetries: parseInt(values['warrant-retries']!, 10),
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
