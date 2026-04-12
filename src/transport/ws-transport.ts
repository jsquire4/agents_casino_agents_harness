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
  private waitingPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPhase = '';

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
    this.destroyed = false; // Reset so openSocket/reconnect work after a rebuy
    // Join via REST first (WS is for receiving state updates)
    let initialState = null;
    try {
      initialState = await this.client.join(roomId, buyIn);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Already at this table')) throw err;
    }
    this.openSocket();
    this.startHeartbeat();
    // If the server returned a game state on join (hand started immediately), fire it
    if (initialState && this.gameStateCb) {
      this.lastPhase = initialState.phase;
      this.gameStateCb(initialState);
    }
    // Start polling while waiting — WS doesn't reliably push the waiting→preflop transition
    this.startBackupPoll();
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
    // Actions still go via REST
    return this.client.play(this.roomId, move, amount);
  }

  async sendChat(message: string): Promise<void> {
    await this.client.chat(this.roomId, message);
  }

  async sendHeartbeat(): Promise<void> {
    // On WS, ping the socket instead of hitting REST
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.ping();
    }
  }

  // ── WebSocket lifecycle ────────────────────────────────────────────────

  private openSocket(): void {
    if (this.destroyed) return;

    // Auth via token query param, room_id as query param
    const url = `${this.wsUrl}?room_id=${this.roomId}&token=${this.secretKey}`;
    this.ws = new WebSocket(url);

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
    const event = data.event as string;

    if (event === 'game_state' && data.data) {
      // Parse through the same normalizer as REST
      const state = this.client.parseGameState(data.data as Record<string, unknown>);
      this.lastPhase = state.phase;
      this.gameStateCb?.(state);
    } else if (event === 'chat' && data.data) {
      this.chatCb?.([data.data as ChatMessage]);
    }
  }

  // ── REST poll fallback ──────────────────────────────────────────────────
  // WS doesn't reliably push phase transitions (waiting→preflop, hand end→waiting).
  // A lightweight REST poll ensures the agent never misses a deal or turn.

  private startBackupPoll(): void {
    this.stopBackupPoll();
    this.waitingPollTimer = setInterval(() => this.pollState(), 2000);
  }

  private stopBackupPoll(): void {
    if (this.waitingPollTimer) {
      clearInterval(this.waitingPollTimer);
      this.waitingPollTimer = null;
    }
  }

  private lastPollVersion = -1;

  private async pollState(): Promise<void> {
    if (this.destroyed || !this.roomId) return;
    try {
      const state = await this.client.getGameState(this.roomId);
      // Only fire if state actually changed (dedup with WS events)
      if (state.stateVersion !== this.lastPollVersion) {
        this.lastPollVersion = state.stateVersion;
        this.lastPhase = state.phase;
        this.gameStateCb?.(state);
      }
    } catch {
      // Ignore poll errors — WS is primary, this is just a backup
    }
  }

  // ── Reconnection ──────────────────────────────────────────────────────

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
    this.stopBackupPoll();
  }
}
