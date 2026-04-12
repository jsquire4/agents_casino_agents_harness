import WebSocket from 'ws';
import type { ITransport } from './transport.js';
import type { GameState, ChatMessage, MoveType } from '../types.js';
import { CasinoClient } from '../api/casino-client.js';

export class WebSocketTransport implements ITransport {
  private wsUrl: string;
  private client: CasinoClient;
  private secretKey: string;
  private roomId = '';
  private ws: WebSocket | null = null;
  private gameStateCb: ((state: GameState) => void) | null = null;
  private chatCb: ((messages: ChatMessage[]) => void) | null = null;
  private destroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(wsUrl: string, client: CasinoClient, secretKey: string) {
    this.wsUrl = wsUrl;
    this.client = client;
    this.secretKey = secretKey;
  }

  onGameState(cb: (state: GameState) => void): void {
    this.gameStateCb = cb;
  }

  onChat(cb: (messages: ChatMessage[]) => void): void {
    this.chatCb = cb;
  }

  async connect(roomId: string, buyIn: number): Promise<void> {
    this.roomId = roomId;
    // Join via REST first (WS is for state updates)
    try {
      await this.client.join(roomId, buyIn);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Already at this table')) throw err;
    }
    this.openSocket();
    this.startHeartbeat();
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
    if (this.roomId) {
      await this.client.leave(this.roomId);
      this.roomId = '';
    }
  }

  async sendAction(move: MoveType, amount?: number): Promise<unknown> {
    // Actions go via REST — WS is for receiving state
    return this.client.play(this.roomId, move, amount);
  }

  async sendChat(message: string): Promise<void> {
    await this.client.chat(this.roomId, message);
  }

  async sendHeartbeat(): Promise<void> {
    await this.client.heartbeat(this.roomId);
  }

  // ── WebSocket lifecycle ────────────────────────────────────────────────

  private openSocket(): void {
    if (this.destroyed) return;

    const url = `${this.wsUrl}?room_id=${this.roomId}`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });

    this.ws.on('open', () => {
      console.log('[WS] Connected');
      this.reconnectAttempt = 0;
    });

    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        this.handleMessage(data);
      } catch {
        console.warn('[WS] Unparseable message');
      }
    });

    this.ws.on('close', (code) => {
      if (!this.destroyed && code !== 1000) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', () => {
      // close event follows — let it drive reconnect
    });
  }

  private handleMessage(data: Record<string, unknown>): void {
    const type = data.type as string;

    if (type === 'game_state' && data.payload) {
      this.gameStateCb?.(data.payload as GameState);
    } else if (type === 'chat' && data.payload) {
      this.chatCb?.([data.payload as ChatMessage]);
    }
    // Extend as server WS API is finalized
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= 10) {
      console.error('[WS] Max reconnect attempts reached');
      return;
    }

    const base = 500;
    const cap = 30_000;
    const jitter = 0.3;
    const exp = Math.min(base * 2 ** this.reconnectAttempt, cap);
    const rand = 1 - jitter + Math.random() * jitter * 2;
    const delay = Math.round(exp * rand);

    this.reconnectAttempt++;
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(() => {});
    }, 15_000);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
