import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config, defaultConfig } from "../src/config";
import { MockOptions } from "../src/mock-venue";
import { World, mockDefaults } from "../src/simulator";

const dirs: string[] = [];
export const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hedge-test-"));
  dirs.push(d);
  return d;
};
process.on("exit", () => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

/** A hedger on a simulated vault and the mock venue, with SOL (and BTC) configured. */
export function world(tune?: (c: Config) => void, venue: Partial<MockOptions> = {}) {
  const config = defaultConfig(["SOL", "BTC"]);
  tune?.(config);
  return new World(config, { ...mockDefaults, ...venue }, tmpDir());
}
/** Whole tokens -> position units; dollars -> e6. */
export const T = (n: number) => BigInt(Math.round(n * 1e6));
export const P = 150_000_000n; // $150
