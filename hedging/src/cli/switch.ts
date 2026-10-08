// Switches hedging on or off. It can be run while the hedger runs: the hedger picks the change up
// on its next pass and records it in its journal.
//
//   on            hedge every configured symbol
//   off           close every hedge and stay out
//   on SOL        hedge SOL, whatever the general setting
//   off SOL       close SOL's hedge and keep it closed
//   clear SOL     SOL follows the general setting again
//   (nothing)     show the switches
//
// Off does not freeze the hedge: it closes it (reduce-only orders), then does nothing.
//
// Run: npm run switch -- [on|off|clear] [symbol] [--state dir]
import { SWITCH_FILE, readSwitchFile, writeSwitches } from "../engine";

const args = process.argv.slice(2);
const at = args.indexOf("--state");
const dir = at >= 0 ? args.splice(at, 2)[1] : new URL("../../state/shadow", import.meta.url).pathname;
const [what, symbol] = args;
let s = readSwitchFile(dir);
if (what === "on" || what === "off") s = symbol ? { ...s, [symbol]: what } : { "*": what };
else if (what === "clear" && symbol) delete s[symbol];
else if (what) throw new Error("usage: switch [on|off|clear] [symbol] [--state dir]");
if (what) writeSwitches(dir, s, process.env.USER ?? "operator");
console.log(`${dir}/${SWITCH_FILE}:`, Object.keys(s).length ? s : "nothing set (hedging is off until switched on)");
