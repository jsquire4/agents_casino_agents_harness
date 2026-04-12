import type { GameState, ChatMessage, MoveType } from '../types.js';

export interface ITransport {
  connect(roomId: string, buyIn: number): Promise<void>;
  disconnect(): Promise<void>;

  onGameState(cb: (state: GameState) => void): void;
  onChat(cb: (messages: ChatMessage[]) => void): void;

  sendAction(move: MoveType, amount?: number): Promise<unknown>;
  sendChat(message: string): Promise<void>;
  sendHeartbeat(): Promise<void>;
}
