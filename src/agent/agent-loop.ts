import type OpenAI from 'openai';
import type { ITransport } from '../transport/transport.js';
import type {
  GameState,
  ChatMessage,
  PersonalityProfile,
  LLMDecision,
  AgentStatusMessage,
  AgentLogMessage,
  AgentTurnMessage,
  AgentChatReceivedMessage,
  AppConfig,
} from '../types.js';
import { LLM_RESPONSE_SCHEMA } from '../types.js';
import { buildSystemPrompt, buildTurnPrompt } from '../llm/prompt-builder.js';
import { validateAndClamp } from '../llm/response-validator.js';
import { shouldExit } from './exit-strategy.js';

export interface AgentLoopConfig {
  agentId: string;
  roomId: string;
  buyIn: number;
  appConfig: AppConfig;
}

export class AgentLoop {
  private transport: ITransport;
  private llm: OpenAI;
  private profile: PersonalityProfile;
  private config: AgentLoopConfig;
  private systemPrompt: string;
  private chatHistory: ChatMessage[] = [];
  private handsPlayed = 0;
  private startingChips: number;
  private lastHandId = '';
  private running = false;
  private acting = false;

  constructor(
    transport: ITransport,
    llm: OpenAI,
    profile: PersonalityProfile,
    config: AgentLoopConfig,
  ) {
    this.transport = transport;
    this.llm = llm;
    this.profile = profile;
    this.config = config;
    this.systemPrompt = buildSystemPrompt(profile);
    this.startingChips = config.buyIn;
  }

  async start(): Promise<void> {
    this.running = true;
    this.log('info', `Starting ${this.profile.nickname} at ${this.config.roomId}`);
    this.emitStatus('starting', 0);

    // Subscribe to events before connecting
    this.transport.onGameState((state) => this.onGameState(state));
    this.transport.onChat((messages) => this.onChat(messages));

    // Connect (join table)
    await this.transport.connect(this.config.roomId, this.config.buyIn);
    this.log('info', 'Seated at table');
    this.emitStatus('waiting', this.config.buyIn);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.emitStatus('exiting', 0);

    // Send farewell chat
    try {
      await this.transport.sendChat(`${this.profile.generated.signature_move} Later! ✌️`);
    } catch { /* best effort */ }

    // Disconnect (leaves table)
    try {
      await this.transport.disconnect();
    } catch { /* best effort */ }

    this.log('info', `Session over. Hands: ${this.handsPlayed}`);
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private async onGameState(state: GameState): Promise<void> {
    if (!this.running) return;

    // Track hand changes
    if (state.id !== this.lastHandId && state.phase !== 'waiting') {
      if (this.lastHandId) {
        this.handsPlayed++;
      }
      this.lastHandId = state.id;
    }

    // Check exit strategy
    if (this.handsPlayed > 0 && shouldExit(this.profile.exit_strategy, {
      handsPlayed: this.handsPlayed,
      startingChips: this.startingChips,
      currentChips: state.you.chips,
    })) {
      this.log('info', 'Exit condition met');
      await this.stop();
      process.exit(0);
    }

    // Update status
    const status = state.isYourTurn ? 'my_turn' : (state.phase === 'waiting' ? 'waiting' : 'playing');
    this.emitStatus(status, state.you.chips);

    // Act if it's our turn
    if (state.isYourTurn && !this.acting) {
      await this.handleTurn(state);
    }
  }

  private onChat(messages: ChatMessage[]): void {
    // Emit each chat message for orchestrator
    for (const msg of messages) {
      const chatMsg: AgentChatReceivedMessage = {
        type: 'chat_received',
        agentId: this.config.agentId,
        from: msg.name,
        message: msg.message,
        timestamp: msg.timestamp,
      };
      console.log(JSON.stringify(chatMsg));
    }

    this.chatHistory.push(...messages);
    // Keep last 20 for context window
    if (this.chatHistory.length > 20) {
      this.chatHistory = this.chatHistory.slice(-20);
    }
  }

  // ── Turn handling ──────────────────────────────────────────────────────

  private async handleTurn(state: GameState): Promise<void> {
    this.acting = true;
    try {
      const decision = await this.getDecision(state);
      this.log('info', `${state.phase}: ${decision.move}${decision.amount ? ` ${decision.amount}` : ''}`);

      // Emit rich turn message for orchestrator
      const holeCards = state.you.holeCards.map(c => `${c.rank}${c.suit[0]}`).join(' ');
      const board = state.communityCards.map(c => `${c.rank}${c.suit[0]}`).join(' ') || '';
      const turnMsg: AgentTurnMessage = {
        type: 'turn',
        agentId: this.config.agentId,
        nickname: this.profile.nickname,
        phase: state.phase,
        move: decision.move,
        amount: decision.amount,
        reasoning: decision.reasoning,
        chatMessage: decision.chat_message,
        equity: state.winProbability,
        pot: state.pot,
        chips: state.you.chips,
        holeCards,
        board,
        timestamp: Date.now(),
      };
      console.log(JSON.stringify(turnMsg));

      // Execute move
      await this.transport.sendAction(decision.move, decision.amount);

      // Send chat
      if (decision.chat_message && decision.chat_message !== '...') {
        await this.transport.sendChat(decision.chat_message);
      }
    } catch (err) {
      this.log('error', `Turn error: ${(err as Error).message}`);
      // Try to fold as safety net
      try {
        await this.transport.sendAction('fold');
      } catch { /* give up */ }
    } finally {
      this.acting = false;
    }
  }

  private async getDecision(state: GameState, attempt = 0): Promise<LLMDecision> {
    const turnPrompt = buildTurnPrompt(state, this.config.agentId, this.chatHistory);

    try {
      const res = await this.llm.chat.completions.create({
        model: this.config.appConfig.openrouterModel,
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: turnPrompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: LLM_RESPONSE_SCHEMA,
        },
        temperature: 0.5,
        max_tokens: 300,
      });

      const content = res.choices[0]?.message?.content;
      if (!content) throw new Error('Empty LLM response');

      const parsed = JSON.parse(content);
      return validateAndClamp(parsed, state.validActions, state.you.chips);
    } catch (err) {
      if (attempt === 0) {
        this.log('warn', `LLM attempt 1 failed: ${(err as Error).message}. Retrying...`);
        return this.getDecision(state, 1);
      }
      this.log('error', `LLM failed twice, folding: ${(err as Error).message}`);
      return {
        move: 'fold',
        chat_message: '...',
        reasoning: `LLM error: ${(err as Error).message}`,
      };
    }
  }

  // ── IPC / logging ──────────────────────────────────────────────────────

  private emitStatus(status: string, chips: number): void {
    const msg: AgentStatusMessage = {
      type: 'status',
      agentId: this.config.agentId,
      nickname: this.profile.nickname,
      status: status as AgentStatusMessage['status'],
      roomId: this.config.roomId,
      chips,
      handsPlayed: this.handsPlayed,
      timestamp: Date.now(),
    };
    console.log(JSON.stringify(msg));
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    const msg: AgentLogMessage = {
      type: 'log',
      agentId: this.config.agentId,
      level,
      message: message.replace(/sk_[a-f0-9]+/g, 'sk_***'),
      timestamp: Date.now(),
    };
    if (level === 'error') {
      console.error(JSON.stringify(msg));
    } else {
      console.log(JSON.stringify(msg));
    }
  }
}
