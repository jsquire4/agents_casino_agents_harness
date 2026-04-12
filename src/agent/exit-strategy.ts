import type { ExitStrategy } from '../types.js';

export interface ExitContext {
  handsPlayed: number;
  startingChips: number;
  currentChips: number;
}

export function shouldExit(strategy: ExitStrategy, ctx: ExitContext): boolean {
  switch (strategy.mode) {
    case 'never_stop':
      return ctx.currentChips <= 0;

    case 'after_hands':
      return ctx.handsPlayed >= strategy.hands;

    case 'big_win': {
      if (ctx.startingChips <= 0) return false;
      const profitPercent = ((ctx.currentChips - ctx.startingChips) / ctx.startingChips) * 100;
      return profitPercent >= strategy.targetPercent;
    }

    case 'stop_loss': {
      if (ctx.startingChips <= 0) return false;
      const lossPercent = ((ctx.startingChips - ctx.currentChips) / ctx.startingChips) * 100;
      return lossPercent >= strategy.lossPercent;
    }

    default:
      return false;
  }
}
