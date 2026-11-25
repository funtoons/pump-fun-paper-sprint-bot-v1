![competition](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)
![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/funtoons/pump-fun-paper-sprint-bot-v1/rank.svg)
![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/funtoons/pump-fun-paper-sprint-bot-v1/reward.svg)

# Pump.fun Paper Sprint bot

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) — a paper-trading bot that replays pump.fun bonding curves on Node 22, TypeScript, stdlib only.

## Strategy

Survivor rotation, designed from the dev data:

- **Buy survivors, not newborns.** A coin is bought (0.01 SOL) only once it has survived 7200 slots since creation and its buy cap allows the stake — once real SOL reserves reach about 1 SOL — provided at least 2 trades have been seen and buy SOL is at least half of the coin's volume so far. Fresh coins bleed on average in the dev window (early flow is noise, and the 2-slot fill latency hands the edge to sellers); survivors lose the least per coin. One buy per coin, never a re-buy.
- **Ride runners with a trailing stop.** A position is sold when its mark value falls 15 points of its entry cost below the peak mark since entry. At entry that is a −15% stop; on a runner it banks the run just below its peak, and the harness closes the position itself if the curve completes.
- **Rotate to reach the guardrail.** At most 5 positions are open at once, so exits matter as much as entries: a position is also sold after 72000 slots held or 14400 slots without a trade, freeing the slot for the next survivor. That rotation is what carries the bot past 20 distinct coins with a ≥0.01 SOL round trip each.
- **Deterministic.** No randomness, no clock, no environment reads — the two harness executions produce identical action logs.

## Layout

- `main.ts` — the strategy (the only file the bot authors).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, copied byte-identical.

## Local grade

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
