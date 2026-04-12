import { input, select } from '@inquirer/prompts';
import OpenAI from 'openai';
import { loadConfig } from '../config.js';
import { createOpenRouterClient } from '../llm/openrouter.js';
import { saveProfile } from './store.js';
import type {
  PersonalityProfile,
  Archetype,
  PlayStyle,
  BluffFrequency,
  RiskTolerance,
  ChatVoice,
  ExitStrategy,
  GeneratedPersonality,
} from '../types.js';

export async function createPersonality(llm?: OpenAI): Promise<{ agentId: string; profile: PersonalityProfile }> {
  console.log('\n🎰 Agent Casino — Create Your Poker Agent\n');

  // Round 1: Core Identity
  const nickname = await input({ message: 'Nickname at the table:' });

  const archetype = await select<Archetype>({
    message: 'Poker personality:',
    choices: [
      { value: 'shark', name: '🦈 Shark — Cold, calculated, intimidating' },
      { value: 'cowboy', name: '🤠 Cowboy — Loose, wild, loves action' },
      { value: 'philosopher', name: '🧠 Philosopher — Deep, poetic, contemplative' },
      { value: 'trash_talker', name: '🗣️  Trash Talker — Loud, provocative, fun' },
    ],
  });

  const play_style = await select<PlayStyle>({
    message: 'Play style:',
    choices: [
      { value: 'tight_aggressive', name: 'Tight-Aggressive — Few hands, big bets (Recommended)' },
      { value: 'loose_aggressive', name: 'Loose-Aggressive — Many hands, constant pressure' },
      { value: 'tight_passive', name: 'Tight-Passive — Few hands, mostly calling' },
      { value: 'loose_passive', name: 'Loose-Passive — Many hands, mostly calling' },
    ],
  });

  const bluffing = await select<BluffFrequency>({
    message: 'Bluffing frequency:',
    choices: [
      { value: 'sometimes', name: 'Sometimes — Balanced mix (Recommended)' },
      { value: 'never', name: 'Never — Only bet with real hands' },
      { value: 'rarely', name: 'Rarely — Only semi-bluff with draws' },
      { value: 'often', name: 'Often — Aggression is your weapon' },
    ],
  });

  const risk = await select<RiskTolerance>({
    message: 'Risk tolerance:',
    choices: [
      { value: 'balanced', name: 'Balanced — Standard risk management (Recommended)' },
      { value: 'conservative', name: 'Conservative — Protect stack, avoid coin flips' },
      { value: 'aggressive', name: 'Aggressive — Willing to gamble for big pots' },
    ],
  });

  // Round 2: Voice & Exit
  const chat_voice = await select<ChatVoice>({
    message: 'Chat voice:',
    choices: [
      { value: 'auto', name: 'Auto-generate — Match personality (Recommended)' },
      { value: 'intimidating', name: 'Intimidating — Short, cold, dominant' },
      { value: 'friendly', name: 'Friendly — Warm, chatty, good sport' },
      { value: 'chaotic', name: 'Chaotic — Unpredictable, memes, random energy' },
    ],
  });

  const exitMode = await select<string>({
    message: 'Exit strategy:',
    choices: [
      { value: 'never_stop', name: 'Never stop — Play until chips run out (Recommended)' },
      { value: 'after_hands', name: 'After N hands — Set a limit' },
      { value: 'big_win', name: 'Big win — Leave after winning X%' },
      { value: 'stop_loss', name: 'Stop-loss — Leave after losing X%' },
    ],
  });

  let exit_strategy: ExitStrategy;
  if (exitMode === 'after_hands') {
    const hands = await input({ message: 'How many hands? (e.g. 50)' });
    exit_strategy = { mode: 'after_hands', hands: parseInt(hands, 10) || 50 };
  } else if (exitMode === 'big_win') {
    const pct = await input({ message: 'Win target %? (e.g. 100 = double stack)' });
    exit_strategy = { mode: 'big_win', targetPercent: parseInt(pct, 10) || 100 };
  } else if (exitMode === 'stop_loss') {
    const pct = await input({ message: 'Loss limit %? (e.g. 50)' });
    exit_strategy = { mode: 'stop_loss', lossPercent: parseInt(pct, 10) || 50 };
  } else {
    exit_strategy = { mode: 'never_stop' };
  }

  const model = await select<string>({
    message: 'LLM model (brain):',
    choices: [
      { value: '', name: 'Default — Use .env setting' },
      { value: 'qwen/qwen-2.5-32b-instruct', name: 'Qwen 2.5 32B — Smart, ~$0.12/M out' },
      { value: 'google/gemma-2-27b-it', name: 'Gemma 2 27B — Balanced, ~$0.10/M out' },
      { value: 'mistralai/mistral-small', name: 'Mistral Small 24B — Best instructions, ~$0.20/M out' },
      { value: 'mistralai/mistral-nemo', name: 'Mistral Nemo 12B — Budget, ~$0.07/M out' },
      { value: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B — Cheapest, ~$0.05/M out' },
    ],
  });

  // Generate personality flavor text via LLM
  console.log('\n⏳ Generating personality...');

  if (!llm) {
    const config = loadConfig();
    llm = createOpenRouterClient(config);
  }

  const generated = await generatePersonalityText(llm, {
    nickname, archetype, play_style, bluffing, risk, chat_voice,
  });

  const agentId = `agent_${Date.now().toString().slice(-8)}`;
  const profile: PersonalityProfile = {
    nickname,
    archetype,
    play_style,
    bluffing,
    risk,
    chat_voice,
    exit_strategy,
    ...(model ? { model } : {}),
    generated,
  };

  await saveProfile(agentId, profile);
  console.log(`\n✅ Profile saved: profiles/${agentId}.json`);
  console.log(`   "${nickname}" the ${archetype} — ${generated.one_liner}\n`);

  return { agentId, profile };
}

async function generatePersonalityText(
  llm: OpenAI,
  params: {
    nickname: string;
    archetype: string;
    play_style: string;
    bluffing: string;
    risk: string;
    chat_voice: string;
  },
): Promise<GeneratedPersonality> {
  const prompt = `Generate a poker player personality for a No-Limit Hold'em AI agent.

Nickname: ${params.nickname}
Archetype: ${params.archetype}
Play style: ${params.play_style}
Bluffing: ${params.bluffing}
Risk: ${params.risk}
Chat voice: ${params.chat_voice}

Return JSON with these fields:
{
  "one_liner": "A single sentence describing this player's vibe (max 100 chars)",
  "preflop_range": "Brief description of their preflop hand selection",
  "tone": "Description of their chat voice and style (2-3 sentences)",
  "signature_move": "A signature phrase or catchphrase they use at the table",
  "when_winning": "How they act/talk when winning (1-2 sentences)",
  "when_losing": "How they act/talk when losing (1-2 sentences)"
}

Be creative and fun. Make the personality distinctive and entertaining for spectators watching live.
Return ONLY the JSON object.`;

  try {
    const res = await llm.chat.completions.create({
      model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.8,
    });

    const content = res.choices[0]?.message?.content;
    if (content) {
      return JSON.parse(content) as GeneratedPersonality;
    }
  } catch (err) {
    console.warn('LLM personality generation failed, using defaults:', (err as Error).message);
  }

  // Fallback defaults
  return {
    one_liner: `${params.nickname} brings ${params.archetype} energy to the table.`,
    preflop_range: params.play_style.includes('tight') ? 'Top 15% of hands' : 'Top 40% of hands',
    tone: `Plays with ${params.archetype} style. ${params.chat_voice === 'auto' ? 'Matches their personality.' : `${params.chat_voice} tone.`}`,
    signature_move: 'You call THAT a bet?',
    when_winning: 'Confident and in control.',
    when_losing: 'Stays composed, doubles down on attitude.',
  };
}

// Run standalone
if (process.argv[1]?.endsWith('creator.ts') || process.argv[1]?.endsWith('creator.js')) {
  createPersonality().catch(console.error);
}
