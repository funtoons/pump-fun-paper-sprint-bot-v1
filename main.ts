// Pump.fun Paper Sprint: survivor-rotation bot.
//
// Design (from the dev data, not from any leaderboard): most fresh pump.fun coins bleed on
// average — early flow is noise and the 2-slot fill latency hands the edge to whoever sold
// first — so this bot only buys coins that have already survived 7200 slots (~25 minutes)
// since creation, and only with buy-dominated early flow. It stakes the 0.01 SOL round-trip
// minimum per coin (a bigger stake loses more per coin to price impact; a smaller one cannot
// meet the guardrail), then rides it with a 15% trailing stop so a runner can go to
// completion while a dud is cut. Max 5 open positions means the bot must rotate: exits free
// a slot for the next coin, which is how it reaches the 20-coin round-trip guardrail.
//
// - onHello is called once before the first batch; the bot needs no setup there because it
//   uses no randomness at all, so the two harness runs agree byte for byte.
// - orders are decided per batch on that batch's slot: exits first (they free nothing until
//   their fills land, so buys only use slots that are really free), then entries.
// - A buy is 0.01 SOL, sent when the mint's buy cap (100 bps of its real SOL reserve) covers
//   the stake, i.e. once real reserves reach about 1 SOL, with at least 2 trades seen and
//   buy SOL at least half of the coin's volume so far.
// - A position is sold when its mark value falls 15 points of its entry cost below the peak
//   mark since entry (an absolute trailing stop: at the entry that is a -15% stop, and on a
//   runner it banks the run just below its peak), or when it has been held more than 72000
//   slots, or when its curve has not traded for 14400 slots (a dead coin should not hold a
//   slot). The harness closes a position itself when its curve completes.
// - Slippage is left wide open so an exit is never refused for the price moving in the
//   2-slot latency; a rejected or failed buy is retried on a later batch.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

/** SOL staked on each coin: 0.01 SOL, the round-trip minimum, so fees stay small in SOL terms. */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** Trailing stop: sell when the mark falls this share of the entry cost below its peak. */
const TRAIL_NUM = 3n;
const TRAIL_DEN = 20n;
/** Max hold, in slots (a long window: survivors are held while they keep trading). */
const MAX_HOLD_SLOTS = 72000;
/** No trade for this many slots: the coin is dead, free the slot. */
const STALE_SLOTS = 14400;
/** Trades seen on a coin before it may be bought. */
const MIN_TRADES = 2;
/** Early buy pressure: buy SOL must be at least this share of the coin's volume so far. */
const BUY_SHARE_NUM = 1n;
const BUY_SHARE_DEN = 2n;
/** Minimum coin age in slots before it may be bought: only coins that survived this long.
// Fresh coins bleed on average (early flow is noise and insiders selling into the 2-slot
// latency), while survivors keep a steadier curve; the gate is what cuts the loss per coin. */
const MIN_AGE_SLOTS = 7200;
/** Wide open: never let a fill be refused for the price moving in the latency. */
const MAX_SLIPPAGE_BPS = 10_000;

interface Candidate {
  buySol: bigint;
  totSol: bigint;
  trades: number;
}

interface Tracked {
  /** Highest mark value (lamports) seen since entry; starts at the entry cost. */
  peak: bigint;
  /** Slot the position first appeared in the account. */
  buySlot: number;
}

/** Coins created and not yet decided, with their early flow totals. */
const candidates = new Map<string, Candidate>();
/** Coins already bought once; a coin is never bought twice. */
const decided = new Set<string>();
/** Open positions with their peak mark and entry slot. */
const tracked = new Map<string, Tracked>();
let buys = 0;
let sells = 0;

/** Mark-to-market value of a holding in lamports, from the curve's virtual reserves. */
function markValue(state: BotState, mint: string, tokens: bigint): bigint | null {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.virtual_token_reserves === 0n) return null;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

await runBot({
  onHello(_state) {
    // hello arrives once, before the first batch. Nothing to seed: the strategy is fully
    // deterministic, so the two executions the harness runs produce identical action logs.
  },
  onBatch(state, batch: Batch) {
    const orders: OrderInput[] = [];
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();

    // A buy that was rejected or whose transaction failed never traded: allow a retry.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status !== 'filled') decided.delete(f.mint);
    }

    // --- Exits, decided on this batch's slot. ---
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }
    for (const pos of state.account.positions) {
      const mint = pos.mint;
      const tokens = BigInt(pos.token_amount);
      const cost = BigInt(pos.cost_lamports);
      if (tokens === 0n || pendingSell.has(mint)) continue;
      let tr = tracked.get(mint);
      if (tr === undefined) {
        tr = { peak: cost, buySlot: state.slot };
        tracked.set(mint, tr);
      }
      const value = markValue(state, mint, tokens);
      if (value === null) continue;
      if (value > tr.peak) tr.peak = value;
      // Sell at the peak minus TRAIL_NUM/TRAIL_DEN of the entry cost.
      const trailLine = tr.peak - (cost * TRAIL_NUM) / TRAIL_DEN;
      const curve = state.curves.get(mint);
      const lastTradeSlot = curve === undefined ? state.slot : curve.reserves_slot;
      const sell =
        value <= trailLine ||
        state.slot - tr.buySlot > MAX_HOLD_SLOTS ||
        state.slot - lastTradeSlot > STALE_SLOTS;
      if (!sell || orders.length >= caps.max_orders_per_batch) continue;
      orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: MAX_SLIPPAGE_BPS });
      sells += 1;
    }

    // --- Entries, decided on this batch's slot. ---
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!candidates.has(e.mint)) {
          candidates.set(e.mint, { buySol: 0n, totSol: 0n, trades: 0 });
        }
        continue;
      }
      if (e.event === 'CompleteEvent') {
        candidates.delete(e.mint);
        continue;
      }
      // TradeEvent: fold the trade into the coin's early flow, then consider buying it.
      let cand = candidates.get(e.mint);
      if (cand === undefined) {
        cand = { buySol: 0n, totSol: 0n, trades: 0 };
        candidates.set(e.mint, cand);
      }
      const sol = BigInt(e.sol_amount);
      if (e.is_buy) cand.buySol += sol;
      cand.totSol += sol;
      cand.trades += 1;
      if (decided.has(e.mint) || state.positions.has(e.mint)) continue;
      // Age gate: only buy a coin that has survived MIN_AGE_SLOTS since creation.
      // A mint first seen through a trade (created before the window, so no CreateEvent
      // arrived) has no known creation slot and is treated as old enough to buy.
      {
        const curve = state.curves.get(e.mint);
        const ageSlots =
          curve === undefined || curve.created_slot === null
            ? 1_000_000_000
            : state.slot - curve.created_slot;
        if (ageSlots < MIN_AGE_SLOTS) continue;
      }
      if (cand.trades < MIN_TRADES) continue;
      if (cand.totSol > 0n && cand.buySol * BUY_SHARE_DEN < cand.totSol * BUY_SHARE_NUM) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < STAKE_LAMPORTS) continue;
      if (orders.length >= caps.max_orders_per_batch || slots <= 0 || free < STAKE_LAMPORTS + tx) continue;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: STAKE_LAMPORTS, max_slippage_bps: MAX_SLIPPAGE_BPS });
      decided.add(e.mint);
      buys += 1;
      free -= STAKE_LAMPORTS + tx;
      slots -= 1;
    }

    // Drop tracking for positions that are gone (sold, completed, flattened).
    for (const mint of [...tracked.keys()]) {
      if (!state.positions.has(mint)) tracked.delete(mint);
    }
    return orders;
  },
  onDone(state, _done) {
    console.error(
      `done: buys=${buys} sells=${sells} distinct=${decided.size} cash=${state.cash} positions=${state.positions.size}`,
    );
  },
});
