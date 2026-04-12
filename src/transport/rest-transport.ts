import type { ITransport } from './transport.js';
import type { GameState, ChatMessage, MoveType } from '../types.js';
import { CasinoClient } from '../api/casino-client.js';

export class RestTransport implements ITransport {
  private client: CasinoClient;
  private intervalMs: number;
  private roomId = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastStateVersion = -1;
  private gameStateCb: ((state: GameState) => void) | null = null;
  private chatCb: ((messages: ChatMessage[]) => void) | null = null;
  private lastChatTimestamp = 0;

  constructor(client: CasinoClient, intervalMs: number) {
    this.client = client;
    this.intervalMs = intervalMs;
  }

  onGameState(cb: (state: GameState) => void): void {
    this.gameStateCb = cb;
  }

  onChat(cb: (messages: ChatMessage[]) => void): void {
    this.chatCb = cb;
  }

  async connect(roomId: string, buyIn: number): Promise<void> {
    this.roomId = roomId;
    try {
      await this.client.join(roomId, buyIn);
    } catch (err: unknown) {
      // "Already at this table" is fine — we're reconnecting
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Already at this table')) throw err;
    }
    this.startPolling();
    this.startHeartbeat();
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.stopHeartbeat();
    if (this.roomId) {
      await this.client.leave(this.roomId);
      this.roomId = '';
    }
  }

  async sendAction(move: MoveType, amount?: number): Promise<unknown> {
    return this.client.play(this.roomId, move, amount);
  }

  async sendChat(message: string): Promise<void> {
    await this.client.chat(this.roomId, message);
  }

  async sendHeartbeat(): Promise<void> {
    await this.client.heartbeat(this.roomId);
  }

  private startPolling(): void {
    this.poll(); // immediate first poll
    this.pollTimer = setInterval(() => this.poll(), this.intervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(() => {});
    }, 15_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const state = await this.client.getGameState(this.roomId);

      // Dedup by stateVersion
      if (state.stateVersion !== this.lastStateVersion) {
        this.lastStateVersion = state.stateVersion;
        this.gameStateCb?.(state);
      }

      // Emit new chat messages
      if (state.chatHistory && state.chatHistory.length > 0) {
        const newMessages = state.chatHistory.filter(
          m => m.timestamp > this.lastChatTimestamp,
        );
        if (newMessages.length > 0) {
          this.lastChatTimestamp = Math.max(...newMessages.map(m => m.timestamp));
          this.chatCb?.(newMessages);
        }
      }
    } catch (err) {
      // Log but don't crash — next poll will retry
      console.error('[RestTransport] Poll error:', (err as Error).message);
    }
  }
}
