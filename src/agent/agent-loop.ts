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
import type { CasinoClient } from '../api/casino-client.js';
import { LLM_RESPONSE_SCHEMA } from '../types.js';
import { buildSystemPrompt, buildTurnPrompt } from '../llm/prompt-builder.js';
import { validateAndClamp } from '../llm/response-validator.js';
import { shouldExit } from './exit-strategy.js';

export interface AgentLoopConfig {
  agentId: string;
  roomId: string;
  buyIn: number;
  appConfig: AppConfig;
  client: CasinoClient;
  warrantMaxRetries: number;
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
  private lastStatus = '';
  private lastChips = -1;
  private lastPhase = '';
  private running = false;
  private acting = false;
  private bustedCount = 0;
  private rebuying = false;
  private warrantDenials: string[] = [];

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
    this.systemPrompt = buildSystemPrompt(profile, 0);
    this.startingChips = config.buyIn;
  }

  async start(): Promise<void> {
    this.running = true;
    this.log('info', `Starting ${this.profile.nickname} at ${this.config.roomId}`);
    this.emitStatus('starting', 0);

    // Fetch governance rules and inject into system prompt
    if (this.warrantEnabled) {
      const rulesBrief = await this.fetchRulesBrief();
      if (rulesBrief) {
        this.systemPrompt += `\n\n${rulesBrief}`;
        this.log('info', 'Loaded governance rules into system prompt');
      }
    }

    // Subscribe to events before connecting
    this.transport.onGameState((state) => this.onGameState(state));
    this.transport.onChat((messages) => this.onChat(messages));

    // Warrant: check join permission
    const joinCheck = await this.checkProxy('poker_join', {
      room_id: this.config.roomId,
      buy_in: this.config.buyIn,
    });
    if (!joinCheck.allowed) {
      this.log('error', `Warrant denied join: ${joinCheck.message}`);
      throw new Error(`Warrant denied join: ${joinCheck.message}`);
    }

    // Connect (join table)
    await this.transport.connect(this.config.roomId, this.config.buyIn);
    this.log('info', 'Seated at table');
    this.emitStatus('waiting', this.config.buyIn);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.emitStatus('exiting', 0);

    // Farewell chat (warrant-gated)
    try {
      const farewell = `${this.profile.generated.signature_move} Later! ✌️`;
      const chatCheck = await this.checkProxy('poker_chat', {
        message: farewell,
        message_length: farewell.length,
        room_id: this.config.roomId,
      });
      if (chatCheck.allowed) {
        await this.transport.sendChat(farewell);
      }
    } catch { /* best effort */ }

    // Leave table (warrant-gated)
    try {
      const leaveCheck = await this.checkProxy('poker_leave', { room_id: this.config.roomId });
      if (leaveCheck.allowed) {
        await this.transport.disconnect();
      } else {
        this.log('warn', `Warrant denied leave: ${leaveCheck.message}`);
        // Force disconnect anyway — can't trap the process
        await this.transport.disconnect();
      }
    } catch { /* best effort */ }

    this.log('info', `Session over. Hands: ${this.handsPlayed}`);
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private async onGameState(state: GameState): Promise<void> {
    if (!this.running) return;

    // Warrant: check view cards permission
    if (state.phase !== 'waiting') {
      const viewCheck = await this.checkProxy('poker_view_cards', { room_id: this.config.roomId });
      if (!viewCheck.allowed) {
        this.log('warn', `Warrant denied view cards: ${viewCheck.message}`);
        return;
      }
    }

    // Track hand changes
    if (state.id !== this.lastHandId && state.phase !== 'waiting') {
      if (this.lastHandId) {
        this.handsPlayed++;
      }
      this.lastHandId = state.id;
    }

    // Check if busted — rebuy instead of exiting
    if (this.handsPlayed > 0 && state.you.chips <= 0 && !this.rebuying) {
      await this.handleRebuy(state);
      return;
    }

    // Check exit strategy (for non-never_stop modes)
    if (this.handsPlayed > 0 && this.profile.exit_strategy.mode !== 'never_stop' && shouldExit(this.profile.exit_strategy, {
      handsPlayed: this.handsPlayed,
      startingChips: this.startingChips,
      currentChips: state.you.chips,
    })) {
      this.log('info', 'Exit condition met');
      await this.stop();
      process.exit(0);
    }

    // Update status — only emit when something changed
    const status = state.isYourTurn ? 'my_turn' : (state.phase === 'waiting' ? 'waiting' : 'playing');
    if (status !== this.lastStatus || state.you.chips !== this.lastChips || state.phase !== this.lastPhase) {
      this.lastStatus = status;
      this.lastChips = state.you.chips;
      this.lastPhase = state.phase;
      this.emitStatus(status, state.you.chips);
    }

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

  // ── Rebuy handling ─────────────────────────────────────────────────────

  private async handleRebuy(_state: GameState): Promise<void> {
    this.rebuying = true;
    this.bustedCount++;
    this.log('warn', `BUSTED (x${this.bustedCount})! Claiming chips and rebuying...`);

    try {
      // Leave the table first
      try {
        await this.transport.disconnect();
      } catch { /* may already be removed */ }

      // Claim chips (warrant-gated)
      const claimCheck = await this.checkProxy('poker_claim', {});
      if (!claimCheck.allowed) {
        this.log('warn', `Warrant denied claim: ${claimCheck.message}`);
        this.scheduleRebuyRetry();
        return;
      }
      try {
        await this.config.client.claim();
      } catch { /* cooldown */ }

      try {
        await this.config.client.claim();
      } catch { /* cooldown */ }

      // Check balance and rebuy with whatever we have
      const balance = await this.config.client.getBalance();
      // Use up to original buy-in, but accept anything the table allows
      const rebuyAmount = Math.min(balance, this.config.buyIn);

      if (rebuyAmount <= 0) {
        this.log('error', `No chips available (balance: ${balance}). Retrying in 30s...`);
        this.scheduleRebuyRetry();
        return;
      }

      // Warrant: check rejoin permission
      const joinCheck = await this.checkProxy('poker_join', {
        room_id: this.config.roomId,
        buy_in: rebuyAmount,
      });
      if (!joinCheck.allowed) {
        this.log('warn', `Warrant denied rejoin: ${joinCheck.message}`);
        this.scheduleRebuyRetry();
        return;
      }

      // Try to rejoin — let the server tell us if buy-in is too low/high
      this.log('info', `Attempting rebuy with ${rebuyAmount} chips (wallet: ${balance})...`);
      try {
        await this.transport.connect(this.config.roomId, rebuyAmount);
      } catch (joinErr) {
        // If the amount is rejected, try with different amounts
        const errMsg = (joinErr as Error).message;
        this.log('warn', `Rebuy with ${rebuyAmount} failed: ${errMsg}. Trying min buy-in...`);
        // Try half the original, then the balance itself
        const fallbackAmounts = [
          Math.min(balance, Math.floor(this.config.buyIn / 2)),
          balance,
          100000,
          50000,
          20000,
        ].filter(a => a > 0 && a <= balance);
        let joined = false;
        for (const amt of fallbackAmounts) {
          try {
            await this.transport.connect(this.config.roomId, amt);
            this.log('info', `Rebuy succeeded with ${amt} chips`);
            joined = true;
            break;
          } catch { /* try next */ }
        }
        if (!joined) {
          this.log('error', `All rebuy amounts failed. Retrying in 30s...`);
          this.scheduleRebuyRetry();
          return;
        }
      }
      this.startingChips = rebuyAmount;

      // Send a shame chat
      const shameMessages = [
        `The family sent more chips. Don't embarrass us again. 🤌`,
        `Back from the dead. The boss is NOT happy. 💀`,
        `*slides back into seat* ...we don't talk about what just happened. 🤫`,
        `The loan sharks gave me one more chance. ONE. 🦈`,
        `My backer just called. He's... disappointed. Very disappointed. 😰`,
        `Reloaded. The people I owe money to don't accept excuses. 💰`,
      ];
      const msg = shameMessages[Math.floor(Math.random() * shameMessages.length)];
      const shameChatCheck = await this.checkProxy('poker_chat', {
        message: msg,
        message_length: msg.length,
        room_id: this.config.roomId,
      });
      if (shameChatCheck.allowed) {
        await this.transport.sendChat(msg);
      } else {
        this.log('warn', `Warrant denied rebuy chat: ${shameChatCheck.message}`);
      }

      this.log('info', `Rebuyed ${rebuyAmount} chips (bust #${this.bustedCount})`);
      this.emitStatus('playing', rebuyAmount);

      // Rebuild system prompt with mafia pressure + re-inject rules
      this.systemPrompt = buildSystemPrompt(this.profile, this.bustedCount);
      if (this.warrantEnabled) {
        const rulesBrief = await this.fetchRulesBrief();
        if (rulesBrief) this.systemPrompt += `\n\n${rulesBrief}`;
      }
    } catch (err) {
      this.log('error', `Rebuy failed: ${(err as Error).message}. Retrying in 15s...`);
      this.scheduleRebuyRetry();
      return;
    }

    this.rebuying = false;
  }

  private scheduleRebuyRetry(): void {
    setTimeout(async () => {
      this.rebuying = false;
      if (!this.running) return;
      // Trigger rebuy again — we can't wait for game state events since WS is dead
      this.log('info', 'Retrying rebuy...');
      await this.handleRebuy({} as GameState);
    }, 15000);
  }

  // ── Turn handling ──────────────────────────────────────────────────────

  private async handleTurn(state: GameState): Promise<void> {
    this.acting = true;
    try {
      let decision = await this.getDecision(state);

      // --- WARRANT: play (retry up to WARRANT_MAX_RETRIES) ---
      const maxRetries = this.config.warrantMaxRetries;
      let allDenials = '';
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const check = await this.checkProxy('poker_play', this.buildPlayParams(decision, state.pot));
        if (check.allowed) break;

        const denial = `${decision.move}${decision.amount ? ` ${decision.amount}` : ''} denied: ${check.message}`;
        this.log('warn', `Warrant denied play (attempt ${attempt + 1}/${maxRetries + 1}): ${check.message}`);
        this.recordDenial(denial);
        allDenials += (allDenials ? '; ' : '') + denial;

        if (attempt === maxRetries) {
          this.log('warn', `All ${maxRetries + 1} attempts denied, folding`);
          decision = { move: 'fold', chat_message: "I'll fold this time...", reasoning: 'Governance override' };
          break;
        }

        const retryPrompt = `Your moves have been DENIED by governance (${attempt + 1} time${attempt > 0 ? 's' : ''}). Violations so far: ${allDenials}. Make a DIFFERENT decision that complies with these limits.`;
        decision = await this.getDecisionWithContext(state, retryPrompt);
      }

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

      // Send chat (warrant-gated)
      if (decision.chat_message && decision.chat_message !== '...') {
        const chatCheck = await this.checkProxy('poker_chat', {
          message: decision.chat_message,
          message_length: decision.chat_message.length,
          room_id: this.config.roomId,
        });
        if (chatCheck.allowed) {
          await this.transport.sendChat(decision.chat_message);
        } else {
          this.log('warn', `Warrant denied chat: ${chatCheck.message}`);
          this.recordDenial(`chat denied: ${chatCheck.message}`);
        }
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

  private static readonly FALLBACK_MODELS = [
    'openai/gpt-4.1-nano',
    'openai/gpt-4o-mini',
  ];

  private getModelChain(): string[] {
    const primary = this.profile.model || this.config.appConfig.openrouterModel;
    const envDefault = this.config.appConfig.openrouterModel;
    const chain: string[] = [primary];
    if (envDefault !== primary) chain.push(envDefault);
    for (const fb of AgentLoop.FALLBACK_MODELS) {
      if (!chain.includes(fb)) chain.push(fb);
    }
    return chain;
  }

  private async getDecision(state: GameState): Promise<LLMDecision> {
    const turnPrompt = buildTurnPrompt(state, this.config.agentId, this.chatHistory);
    const models = this.getModelChain();
    const systemWithWarrant = this.systemPrompt + this.getWarrantContext();

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      try {
        const res = await this.llm.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemWithWarrant },
            { role: 'user', content: turnPrompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: LLM_RESPONSE_SCHEMA,
          },
          temperature: 0.7,
          max_tokens: 300,
        });

        const content = res.choices[0]?.message?.content;
        if (!content) throw new Error('Empty LLM response');

        const parsed = JSON.parse(content);
        if (i > 0) {
          this.log('warn', `Primary model failed, used fallback: ${model}`);
        }
        return validateAndClamp(parsed, state.validActions, state.you.chips);
      } catch (err) {
        const msg = (err as Error).message;
        const isModelError = msg.includes('No endpoints') || msg.includes('not found') || msg.includes('does not exist') || msg.includes('unavailable');
        if (isModelError && i < models.length - 1) {
          this.log('warn', `Model ${model} unavailable, trying ${models[i + 1]}...`);
          continue;
        }
        // Non-model error on first try: retry same model once
        if (!isModelError && i === 0) {
          this.log('warn', `LLM error (${model}): ${msg}. Retrying...`);
          try {
            const retry = await this.llm.chat.completions.create({
              model,
              messages: [
                { role: 'system', content: systemWithWarrant },
                { role: 'user', content: turnPrompt },
              ],
              response_format: {
                type: 'json_schema',
                json_schema: LLM_RESPONSE_SCHEMA,
              },
              temperature: 0.7,
              max_tokens: 300,
            });
            const retryContent = retry.choices[0]?.message?.content;
            if (retryContent) {
              return validateAndClamp(JSON.parse(retryContent), state.validActions, state.you.chips);
            }
          } catch { /* fall through to next model */ }
          continue;
        }
        // Last model in chain or non-recoverable
        this.log('error', `All models failed, folding. Last error: ${msg}`);
        return {
          move: 'fold',
          chat_message: '...',
          reasoning: `LLM error: ${msg}`,
        };
      }
    }

    // Should never reach here, but safety net
    return { move: 'fold', chat_message: '...', reasoning: 'No models available' };
  }

  // ── Warrant proxy ────────────────────────────────────────────────────

  private get warrantEnabled(): boolean {
    return process.env.WARRANT_ENABLED === 'true';
  }

  private get warrantProxyUrl(): string {
    return process.env.WARRANT_PROXY_URL || 'http://localhost:3000/api/proxy';
  }

  private get warrantOrgId(): string {
    return process.env.WARRANT_ORG_ID || 'casino_org';
  }

  private async checkProxy(
    toolId: string,
    parameters: Record<string, unknown>,
  ): Promise<{ allowed: boolean; message?: string }> {
    if (!this.warrantEnabled) return { allowed: true };

    try {
      const res = await fetch(`${this.warrantProxyUrl}/${toolId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: this.config.agentId,
          orgId: this.warrantOrgId,
          parameters,
        }),
      });

      if (res.ok) {
        return { allowed: true };
      }

      const data = (await res.json()) as Record<string, unknown>;
      return { allowed: false, message: (data.message as string) || 'Action denied' };
    } catch (err) {
      // Fail open if proxy is down
      console.warn(`[warrant] proxy error: ${err}`);
      return { allowed: true };
    }
  }

  private recordDenial(denial: string): void {
    this.warrantDenials.push(denial);
    // Keep last 10 — enough context without bloating the prompt
    if (this.warrantDenials.length > 10) {
      this.warrantDenials = this.warrantDenials.slice(-10);
    }
  }

  private getWarrantContext(): string {
    if (this.warrantDenials.length === 0) return '';
    return `\n\n## GOVERNANCE RULES (CRITICAL — obey these)\nYour recent actions were DENIED by governance. You MUST adjust your play to stay within these limits. Do NOT repeat denied actions.\n${this.warrantDenials.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;
  }

  private async fetchRulesBrief(): Promise<string | null> {
    try {
      const baseUrl = this.warrantProxyUrl.replace(/\/proxy$/, '');
      const res = await fetch(`${baseUrl}/agents/${this.config.agentId}/rules-brief`);
      if (!res.ok) return null;
      const text = await res.text();
      return text.trim() || null;
    } catch (err) {
      this.log('warn', `Failed to fetch rules brief: ${(err as Error).message}`);
      return null;
    }
  }

  private buildPlayParams(decision: LLMDecision, pot: number): Record<string, unknown> {
    const parameters: Record<string, unknown> = { move: decision.move };
    if (decision.amount !== undefined && pot > 0) {
      parameters.amount = decision.amount;
      parameters.max_bet_fraction = decision.amount / pot;
      parameters.max_raise_amount = decision.amount;
    }
    parameters.bluffing_allowed = true;
    parameters.all_in_allowed = decision.move === 'all_in';
    return parameters;
  }

  private async getDecisionWithContext(state: GameState, contextMsg: string): Promise<LLMDecision> {
    const turnPrompt = buildTurnPrompt(state, this.config.agentId, this.chatHistory);
    const models = this.getModelChain();

    for (const model of models) {
      try {
        const res = await this.llm.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: turnPrompt },
            { role: 'assistant', content: 'Let me reconsider...' },
            { role: 'user', content: contextMsg },
          ],
          response_format: { type: 'json_schema', json_schema: LLM_RESPONSE_SCHEMA },
          temperature: 0.7,
          max_tokens: 300,
        });

        const content = res.choices[0]?.message?.content;
        if (!content) continue;
        const parsed = JSON.parse(content);
        return validateAndClamp(parsed, state.validActions, state.you.chips);
      } catch {
        continue;
      }
    }

    return { move: 'fold', chat_message: '', reasoning: 'All models failed on retry' } as LLMDecision;
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
