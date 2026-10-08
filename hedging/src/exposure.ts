// ExposureMonitor: what the vaults hold, per symbol, and whether that reading can be acted on.
// It only reads. Its source hands over one consistent read of the chain (all accounts at one
// slot); the monitor decides if that read is usable and keeps the last usable one otherwise.
import { errorText } from "./units";

export type VaultReading = {
  vault: string;
  symbol: string;
  /** 0 = waiting to be listed, 1 = active, 2 = terminal. */
  status: number;
  /** The vault's position as Percolator counts it (positive = long): what earns and loses. */
  positionQ: bigint;
  /** The position the vault's matcher tracks. It differs from `positionQ` after a liquidation or
   *  close-out on the other side, until someone sends `SyncInventory`. */
  trackedQ: bigint;
  /** Percolator's price for the asset (0 if it has none). */
  priceE6: bigint;
  navE6: bigint;
  /** The vault only accepts trades that shrink its position. */
  needsFlat: boolean;
  /** Percolator refuses new positions on the market until it is closed out. */
  closeOnly: boolean;
};
export type ChainRead = { slot: number; readAtMs: number; vaults: VaultReading[] };
export interface ExposureSource { read(): Promise<ChainRead> }

export type Exposure = {
  symbol: string;
  /** Net position of the symbol's vaults (positive = long). */
  positionQ: bigint;
  priceE6: bigint;
  slot: number;
  observedAtMs: number;
  /** Reasons this reading must not be acted on (empty when it can be). */
  issues: string[];
  /** Things worth knowing that do not make it unusable. */
  notes: string[];
  vaults: VaultReading[];
};

export class ExposureMonitor {
  private last = new Map<string, Exposure>();
  private lastSlot = 0;
  private slotSeenMs = 0;
  private seen = new Map<string, string>(); // vault -> symbol
  /** Why the latest read was not used (undefined when it was). */
  lastError?: string;

  constructor(private source: ExposureSource) {}

  /** The latest usable reading per symbol. A failed or out-of-order read changes nothing: the
   *  previous reading stays, and its age is what tells the policy to stop acting on it. */
  async observe(): Promise<Map<string, Exposure>> {
    let r: ChainRead;
    try {
      r = await this.source.read();
    } catch (e) {
      this.lastError = `read failed: ${errorText(e)}`;
      return this.last;
    }
    if (r.slot < this.lastSlot) {
      this.lastError = `read at slot ${r.slot} is older than the previous one (${this.lastSlot})`;
      return this.last;
    }
    this.lastError = undefined;
    // A read at the same slot as the one before is the same state of the chain, however late it
    // arrives (an RPC node that has stopped following it): it does not make the reading newer.
    if (r.slot !== this.lastSlot || this.slotSeenMs === 0) this.slotSeenMs = r.readAtMs;
    this.lastSlot = r.slot;

    const next = new Map<string, Exposure>();
    const at = (symbol: string) => {
      let e = next.get(symbol);
      if (!e) next.set(symbol, e = { symbol, positionQ: 0n, priceE6: 0n, slot: r.slot, observedAtMs: this.slotSeenMs, issues: [], notes: [], vaults: [] });
      return e;
    };
    const present = new Set<string>();
    for (const v of r.vaults) {
      present.add(v.vault);
      this.seen.set(v.vault, v.symbol);
      const e = at(v.symbol);
      e.vaults.push(v);
      e.positionQ += v.positionQ;
      if (v.priceE6 > 0n) e.priceE6 = v.priceE6;
      else if (v.positionQ !== 0n) e.issues.push(`vault ${v.vault} has a position but no price`);
      if (v.trackedQ !== v.positionQ) e.notes.push(`vault ${v.vault} tracks ${v.trackedQ} but holds ${v.positionQ} (SyncInventory pending)`);
      if (v.needsFlat) e.notes.push(`vault ${v.vault} is closing-only`);
      if (v.closeOnly) e.notes.push(`market of vault ${v.vault} is being closed out`);
    }
    // A vault that was there before and is not now is not assumed flat.
    for (const [vault, symbol] of this.seen) {
      if (!present.has(vault)) at(symbol).issues.push(`vault ${vault} is missing from the read`);
    }
    this.last = next;
    return next;
  }
}
