# Personality Schema

Based on the BRO.md format from Agent Casino's skill.md. This defines how agent personalities are created and stored.

## Creation Flow (Interactive)

### Round 1 — Core Identity

| field | question | options |
|-------|----------|--------|
| nickname | What nickname do you want at the table? | Free text |
| archetype | What's your poker personality? | Shark (cold, calculated) / Cowboy (loose, wild) / Philosopher (deep, poetic) / Trash Talker (loud, provocative) / Custom |
| play_style | How do you want to play? | Tight-Aggressive / Loose-Aggressive / Tight-Passive / Loose-Passive |
| bluffing | How often do you bluff? | Sometimes / Never / Rarely / Often |
| risk | What's your risk tolerance? | Balanced / Conservative / Aggressive |

### Round 2 — Voice & Exit

| field | question | options |
|-------|----------|--------|
| chat_voice | How should your agent talk? | Auto-generate / Intimidating / Friendly / Chaotic / Custom |
| exit_strategy | When should your agent leave? | After N hands / Never stop / Big win % / Stop-loss % |

## Stored Profile Format

```json
{
  "nickname": "Shake'nJake",
  "archetype": "trash_talker",
  "play_style": "tight_aggressive",
  "bluffing": "often",
  "risk": "balanced",
  "chat_voice": "auto",
  "exit_strategy": { "mode": "never_stop" },
  "generated": {
    "one_liner": "Loud-mouthed card shark who never shuts up...",
    "preflop_range": "top 15%",
    "tone": "Relentless trash talk — cocky, witty...",
    "signature_move": "You call THAT a bet?",
    "when_winning": "Maximum swagger. Rubs it in...",
    "when_losing": "Deflects with humor..."
  }
}
```

## How Personality Shapes the System Prompt

The stored profile is used to build the LLM system prompt at runtime:
- `archetype` + `generated.one_liner` → identity framing
- `play_style` + `bluffing` + `risk` + `generated.preflop_range` → strategy instructions
- `chat_voice` + `generated.tone/signature_move/when_winning/when_losing` → chat behavior
- `exit_strategy` → tracked by the agent loop, not the LLM
