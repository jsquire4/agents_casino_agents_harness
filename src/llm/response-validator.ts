import type { LLMDecision, ValidAction, MoveType } from '../types.js';

const VALID_MOVES: MoveType[] = ['fold', 'check', 'call', 'raise', 'all_in'];

export function validateAndClamp(
  raw: unknown,
  validActions: ValidAction[],
  myChips: number,
): LLMDecision {
  // Parse if string
  let decision: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      decision = JSON.parse(raw);
    } catch {
      return fallbackFold('JSON parse error');
    }
  } else {
    decision = raw as Record<string, unknown>;
  }

  // Extract fields
  let move = String(decision.move || 'fold') as MoveType;
  let amount = typeof decision.amount === 'number' ? decision.amount : undefined;
  let chatMessage = String(decision.chat_message || '...');
  const reasoning = String(decision.reasoning || 'no reasoning provided');

  // Validate move is a known type
  if (!VALID_MOVES.includes(move)) {
    move = 'fold';
  }

  const validMoveTypes = validActions.map(a => a.action);

  // Check is only valid when no bet to face
  if (move === 'check' && !validMoveTypes.includes('check')) {
    move = validMoveTypes.includes('fold') ? 'fold' : 'check';
  }

  // Call when call isn't valid (e.g., no bet to face — should check)
  if (move === 'call' && !validMoveTypes.includes('call')) {
    move = validMoveTypes.includes('check') ? 'check' : 'fold';
  }

  // Raise validation
  if (move === 'raise') {
    const raiseAction = validActions.find(a => a.action === 'raise');
    if (!raiseAction) {
      // Can't raise — try call or check
      move = validMoveTypes.includes('call') ? 'call' :
             validMoveTypes.includes('check') ? 'check' : 'fold';
      amount = undefined;
    } else {
      const minRaise = raiseAction.minAmount || 0;
      const maxRaise = raiseAction.maxAmount || myChips;

      if (amount === undefined || amount < minRaise) {
        amount = minRaise;
      }
      if (amount > maxRaise) {
        // Over max — clamp to max raise, NOT all-in
        amount = maxRaise;
      }
    }
  }

  // All-in check
  if (move === 'all_in' && !validMoveTypes.includes('all_in')) {
    move = validMoveTypes.includes('raise') ? 'raise' :
           validMoveTypes.includes('call') ? 'call' : 'fold';
    if (move === 'raise') {
      const raiseAction = validActions.find(a => a.action === 'raise');
      amount = raiseAction?.maxAmount || myChips;
    }
  }

  // Strip amount on non-raise moves
  if (move !== 'raise') {
    amount = undefined;
  }

  // Truncate chat
  if (chatMessage.length > 500) {
    chatMessage = chatMessage.slice(0, 497) + '...';
  }

  return { move, amount, chat_message: chatMessage, reasoning };
}

function fallbackFold(reason: string): LLMDecision {
  return {
    move: 'fold',
    chat_message: '...',
    reasoning: `Fallback fold: ${reason}`,
  };
}
