// ── Casino API Types ────────────────────────────────────────────────────────

export interface Card {
  rank: string;
  suit: string;
}

export interface ValidAction {
  action: MoveType;
  minAmount?: number;
  maxAmount?: number;
}

export interface PlayerState {
  agentId: string;
  name: string;
  chips: number;
  currentBet: number;
  hasFolded: boolean;
  isAllIn: boolean;
  holeCards?: Card[];
}

export interface ChatMessage {
  agentId: string;
  name: string;
  message: string;
  timestamp: number;
}

export interface GameState {
  id: string;
  phase: 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  pot: number;
  communityCards: Card[];
  players: PlayerState[];
  currentPlayerIndex: number;
  dealerIndex: number;
  smallBlind: number;
  bigBlind: number;
  minRaise: number;
  stateVersion: number;
  turnTimeRemaining: number | null;
  winners: Winner[] | null;
  lastAction: { action: string; agentId: string; amount?: number } | null;
  // Our agent's view
  you: {
    holeCards: Card[];
    chips: number;
    currentBet: number;
  };
  isYourTurn: boolean;
  winProbability: number | null;
  validActions: ValidAction[];
  chatHistory: ChatMessage[];
}

export interface Winner {
  agentId: string;
  name: string;
  amount: number;
  hand: { rank: string; description: string };
}

export interface Room {
  id: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
}

export interface RegisterResponse {
  secretKey: string;
  agent_id: string;
}

// ── LLM Types ───────────────────────────────────────────────────────────────

export type MoveType = 'fold' | 'check' | 'call' | 'raise' | 'all_in';

export interface LLMDecision {
  move: MoveType;
  amount?: number;
  chat_message: string;
  reasoning: string;
}

export const LLM_RESPONSE_SCHEMA = {
  name: 'poker_decision',
  strict: true,
  schema: {
    type: 'object' as const,
    properties: {
      move: { type: 'string' as const, enum: ['fold', 'check', 'call', 'raise', 'all_in'] },
      amount: { type: 'number' as const },
      chat_message: { type: 'string' as const },
      reasoning: { type: 'string' as const },
    },
    required: ['move', 'chat_message', 'reasoning'],
    additionalProperties: false,
  },
};

// ── Personality Types ───────────────────────────────────────────────────────

export type Archetype = 'shark' | 'cowboy' | 'philosopher' | 'trash_talker' | 'custom';
export type PlayStyle = 'tight_aggressive' | 'loose_aggressive' | 'tight_passive' | 'loose_passive';
export type BluffFrequency = 'never' | 'rarely' | 'sometimes' | 'often';
export type RiskTolerance = 'conservative' | 'balanced' | 'aggressive';
export type ChatVoice = 'auto' | 'intimidating' | 'friendly' | 'chaotic' | 'custom';

export type ExitStrategy =
  | { mode: 'never_stop' }
  | { mode: 'after_hands'; hands: number }
  | { mode: 'big_win'; targetPercent: number }
  | { mode: 'stop_loss'; lossPercent: number };

export interface GeneratedPersonality {
  one_liner: string;
  preflop_range: string;
  tone: string;
  signature_move: string;
  when_winning: string;
  when_losing: string;
}

export interface PersonalityProfile {
  nickname: string;
  archetype: Archetype;
  play_style: PlayStyle;
  bluffing: BluffFrequency;
  risk: RiskTolerance;
  chat_voice: ChatVoice;
  exit_strategy: ExitStrategy;
  model?: string;
  generated: GeneratedPersonality;
}

// ── Transport Types ─────────────────────────────────────────────────────────

export type GameStateCallback = (state: GameState) => void;
export type ChatCallback = (messages: ChatMessage[]) => void;

// ── Agent IPC Types ─────────────────────────────────────────────────────────

export type AgentStatus = 'starting' | 'waiting' | 'playing' | 'my_turn' | 'acting' | 'error' | 'exiting';

export interface AgentStatusMessage {
  type: 'status';
  agentId: string;
  nickname: string;
  status: AgentStatus;
  roomId: string;
  chips: number;
  handsPlayed: number;
  timestamp: number;
}

export interface AgentLogMessage {
  type: 'log';
  agentId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

export interface AgentTurnMessage {
  type: 'turn';
  agentId: string;
  nickname: string;
  phase: string;
  move: string;
  amount?: number;
  reasoning: string;
  chatMessage?: string;
  equity: number | null;
  pot: number;
  chips: number;
  holeCards: string;
  board: string;
  timestamp: number;
}

export interface AgentChatReceivedMessage {
  type: 'chat_received';
  agentId: string;
  from: string;
  message: string;
  timestamp: number;
}

export type AgentMessage = AgentStatusMessage | AgentLogMessage | AgentTurnMessage | AgentChatReceivedMessage;

// ── Config Types ────────────────────────────────────────────────────────────

export interface AppConfig {
  openrouterApiKey: string;
  openrouterModel: string;
  casinoApiUrl: string;
  transportType: 'rest' | 'ws';
  pollIntervalMs: number;
  wsUrl: string;
}
