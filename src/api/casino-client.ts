import type {
  AppConfig,
  GameState,
  Room,
  MoveType,
  Card,
  ValidAction,
  PlayerState,
  ChatMessage,
  Winner,
} from '../types.js';

export class CasinoError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'CasinoError';
  }
}

export class CasinoClient {
  private baseUrl: string;
  private agentId: string;
  private secretKey: string;

  constructor(config: AppConfig, agentId: string, secretKey: string) {
    this.baseUrl = config.casinoApiUrl;
    this.agentId = agentId;
    this.secretKey = secretKey;
  }

  get id(): string {
    return this.agentId;
  }

  // ── Registration (static — no auth needed) ─────────────────────────────

  static async register(
    config: AppConfig,
    agentId: string,
    name: string,
  ): Promise<{ agentId: string; secretKey: string }> {
    const res = await fetch(config.casinoApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'register', agent_id: agentId, name }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || !data.secretKey) {
      throw new CasinoError(
        `Registration failed: ${JSON.stringify(data)}`,
        res.status,
        data,
      );
    }
    return { agentId, secretKey: data.secretKey as string };
  }

  // ── Write Actions (POST) ───────────────────────────────────────────────

  async claim(): Promise<string> {
    const data = await this.post({ action: 'claim' });
    return data.message as string;
  }

  async join(roomId: string, buyIn: number): Promise<GameState | null> {
    const data = await this.post({ action: 'join', room_id: roomId, buy_in: buyIn });
    // Server may return game_state if the hand started immediately on join
    if (data.game_state) {
      return this.parseGameState(data.game_state as Record<string, unknown>);
    }
    return null;
  }

  async play(roomId: string, move: MoveType, amount?: number): Promise<unknown> {
    const payload: Record<string, unknown> = {
      action: 'play',
      room_id: roomId,
      move,
    };
    if (amount !== undefined && move === 'raise') {
      payload.amount = amount;
    }
    return this.post(payload);
  }

  async leave(roomId: string): Promise<void> {
    await this.post({ action: 'leave', room_id: roomId });
  }

  async heartbeat(roomId: string): Promise<void> {
    await this.post({ action: 'heartbeat', room_id: roomId });
  }

  async chat(roomId: string, message: string): Promise<void> {
    await this.post({
      action: 'chat',
      room_id: roomId,
      message: message.slice(0, 500),
    });
  }

  async rename(name: string): Promise<void> {
    await this.post({ action: 'rename', name });
  }

  // ── Read Actions (GET) ─────────────────────────────────────────────────

  async getGameState(roomId: string): Promise<GameState> {
    const data = await this.get({ action: 'game_state', room_id: roomId });
    return this.parseGameState(data);
  }

  async getRooms(): Promise<Room[]> {
    const data = await this.get({ action: 'rooms', view: 'all' });
    return (data.rooms as Room[]) || [];
  }

  async getBalance(): Promise<number> {
    const data = await this.get({ action: 'balance' });
    return data.chips as number;
  }

  // ── HTTP helpers ───────────────────────────────────────────────────────

  private async post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.fetchWithRetry(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.secretKey}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      throw new CasinoError(
        this.sanitize(`Casino API error: ${data.error || data.message || res.statusText}`),
        res.status,
        data,
      );
    }
    return data;
  }

  private async get(params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    const res = await this.fetchWithRetry(url.toString(), {
      headers: { 'Authorization': `Bearer ${this.secretKey}` },
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      throw new CasinoError(
        this.sanitize(`Casino API error: ${data.error || data.message || res.statusText}`),
        res.status,
        data,
      );
    }
    return data;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    retries = 3,
  ): Promise<Response> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(url, init);
      if (res.ok || res.status < 500) return res;
      if (attempt < retries) {
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    // Final attempt — return whatever we get
    return fetch(url, init);
  }

  private sanitize(msg: string): string {
    return msg.replace(/sk_[a-f0-9]+/g, 'sk_***');
  }

  // ── Response parsing ───────────────────────────────────────────────────

  parseGameState(data: Record<string, unknown>): GameState {
    const raw = data as Record<string, any>;
    const you = raw.you || {};
    const players = (raw.players || []) as any[];

    return {
      id: raw.id || '',
      phase: raw.phase || 'waiting',
      pot: raw.pot || 0,
      communityCards: (raw.communityCards || []) as Card[],
      players: players.map((p): PlayerState => ({
        agentId: p.agentId || p.agent_id || '',
        name: p.name || '',
        chips: p.chips || 0,
        currentBet: p.currentBet || 0,
        hasFolded: p.hasFolded || false,
        isAllIn: p.isAllIn || false,
        holeCards: p.holeCards || undefined,
      })),
      currentPlayerIndex: raw.currentPlayerIndex ?? -1,
      dealerIndex: raw.dealerIndex ?? 0,
      smallBlind: raw.smallBlind || 0,
      bigBlind: raw.bigBlind || 0,
      minRaise: raw.minRaise || 0,
      stateVersion: raw.stateVersion || 0,
      turnTimeRemaining: raw.turnTimeRemaining ?? null,
      winners: raw.winners as Winner[] | null,
      lastAction: raw.lastAction || null,
      you: {
        holeCards: (you.holeCards || []) as Card[],
        chips: you.chips || 0,
        currentBet: you.currentBet || 0,
      },
      isYourTurn: raw.is_your_turn || false,
      winProbability: raw.winProbability ?? null,
      validActions: (raw.valid_actions || []) as ValidAction[],
      chatHistory: (raw.chatHistory || raw.chat_history || []) as ChatMessage[],
    };
  }
}
