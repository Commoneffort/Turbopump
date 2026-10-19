// Addresses for the serverless functions (mirrors src/devnet.json, src/x1-testnet.json and
// src/chain.ts KNOWN_FEEDS). The programs have the same addresses on both networks.
export const PERCOLATOR = "8o3uV87X2CvPYfPwM1sxeaYYE7sGWsTUiEy7SskEMM3P";
export const VAULT_PROGRAM = "BSync6F8gtJs3Wj4w8L6H3ZtS397w2XoCYGEAJGmeYX";
export const MARKET = "8ZMjDzhAgcV7zidvkRXM257Dp2HmzeNz7jpbTFvRE1Ls";
export const ROUTER = "DkK9TSMpVXLq26HeqxTXLysXyRKDYHTKU94SLFDWgjw3";
export const FEED_SYMBOLS: Record<string, string> = {
  ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d: "SOL",
  e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43: "BTC",
  ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace: "ETH",
  "0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff": "PYTH",
  dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c: "DOGE",
  "4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b": "HYPE",
  "765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2": "XAU",
  a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b: "EUR",
  // X1 only: sha256("x1:" + symbol).
  "18ef2a004058135517c775c4e45e8c6ae6b6583336c70902329127f87a6d7d81": "ZEC",
  "c7263494c2cf4f1f14575d26864d06f9d9718ebc7c1af2fc28506ef19415b392": "FARTCOIN",
  "6d1cb9acc057a81bbf43ce459ce7bdfc3db1a040b25718158bf6d9936025838f": "TSLA",
  "d0316d5ef0f1e4bbcf08c8ec72444bf005412a87c5368e130feac8afd862d6c8": "NVDA",
  "2a4b5bcc3a1a7b6633350fb2f75cc514c57a19071277b992cf4eef17bc20b69e": "MSTR",
  "c98e089b103f2766952e1490d902cb3a811c700e0064d4cee7c2ba6abef37ce6": "AAPL",
  "55fe35fea9478cdac31cff1c57883213faab338a84d1dca3d3b9ca8b91fe7e70": "GOOGL",
  "fb1093c2bfb0c40661d0d6b7731d08cab10bf111a77103e05ff3567ad18d969a": "META",
  "665db1539de0d2082e2c2aa72f62317b6f9a2e3d72fe7f9b041b93e31d7ac2f4": "AMD",
  "7e2e57832cf14dd0ac3bc79fd2560cfe86f388ade5d9a4d00d1528b75456abec": "COIN",
  "66020da42582157facbf93cc3d944e51c4f15c8a4effec7edf4a18b72c846a71": "PLTR",
  "38853158dfc20e282627dbc05fc728756ba7e9d5f1d483a8aeccf0123e072372": "SPCX",
  "2f9cfc1fca7825bbffe689fcbadd465aecbf42be88e090f0acd23ed427d57dfd": "SPY",
  "e8ecabe1b6c5da82b3a4d5139699da03fb89342705688370b5ac124d91124bb7": "XAG",
};

/** What differs between the two deployments. A request names its network with ?network=x1-testnet
 *  (the page does, from its network switch); anything else is Solana devnet. */
export const NETWORKS = {
  devnet: { rpc: process.env.RPC_URL ?? "https://api.devnet.solana.com", market: MARKET, mint: "FT7B8rR8NN1ciyGPmTDT8AxUUWtF1PGc4NCmuisYVPkh", faucetSecret: "FAUCET_SECRET", coin: "SOL", drip: 0.3, lowWater: 0.2 },
  "x1-testnet": { rpc: process.env.X1_RPC_URL ?? "https://rpc.testnet.x1.xyz", market: "EmNL4qAvngUBAga4Wv3DWkQbtRAJfXq61NhdpzeGWaoJ", mint: "7jpUVrakCqTm68aatnDHYe7qhSF7Zq39PWoSKM1u2Aaw", faucetSecret: "FAUCET_SECRET_X1", coin: "XNT", drip: 0.3, lowWater: 0.2 },
};
export const networkOf = (req: any) => (req?.query?.network === "x1-testnet" ? NETWORKS["x1-testnet"] : NETWORKS.devnet);

/** Wallets that seeded demo activity (scripts/seed.ts). The site labels them. */
export const SEED_WALLETS: Record<string, string> = {
  HRKeXCveDknpLQTuc6FiUzGoxabU53USwJEMbguMPnj9: "seed LP",
  BobEW42aDUTzntjiqavc5fRQWt9VnN1JMBG8dcLV4xRQ: "seed trader 1",
  HoNb9L6dM25qHMQWjn7FqX7CvDWN8g97sdb56UqYtPZF: "seed trader 2",
  "6Bosp4sCkYs2Fbzt2PYY4whVMaL5xUhfkUoytZvbnRWa": "seed trader 3",
  "4caXfNghsBer5SVEykPZhqNTq7te7LTQ9MQ8rVLGUYzK": "demo video",
  // Trading bots (scripts/bots.ts): test traffic.
  DR6dywLBPZbAKtysC8wFeWjxWdnKeAuP5tuFvkraLhNL: "bot fade",
  GAzM5PjXyJSoD7b4JQcfxUN11wgddgGhtkR86CYcaFv3: "bot max",
  DjqeGNpyk4ttVxgWN6BWAA5qbM6Cn1CZGAxfiK3PctF4: "bot random",
  "2fZKcBA2Nt8pwgLHkE5HWhqTrLA8tCGtLaib2VMHo6zM": "bot trend",
  FxtM8o3iRDLmhMWcEMWm6425mubDnuteV5K1tqkFFnyv: "bot edge long",
  JDR76VfChk6nTK4bU9fukTFD8bX3GauUTuPnCASJhsgm: "bot edge short",
  CAWog9UR6HXHo7TTzWotRgA6nWFpcb8XQR6NQaEvygGY: "bot orders",
  cVvyJVUPvYwCdY5V5fZU4TtxPEwSmK9XxHw6Watq5xk: "bot lp",
  "3UTHVFRrbrPqHYUXSvK5Q83ZXZuoMYfnwBa3MbseERNJ": "bot cross",
  "5GCrtKDLpDmE2EWfewCXf4EixUuFtjHot9MfksrDfKfT": "bot scalper",
  "51e8HyFnarHEMyQvtoW1TDAB95stgrwg3iwSqn9Lpedi": "bot adversary",
  JQB1Sb29f8SUQjF5bdx2GPSimpD541ouMn8gCczkaYC: "bot burst 1",
  Ansv4kZqfWpZjHXBD8XLZCbBTX21jUwtUwLpDq6aqgFR: "bot burst 2",
  Fe9J6uEAQLUsBymZcf38AwHwnRyAVzkPAyhRtCQtGQjp: "bot burst 3",
  EzGZ2BAhGKyUZ1zp22cgnkhHGWFcsdvX3U6GfnWuXkiy: "bot burst 4",
  "8gGpXF8SGwtqJY7iwTbF6tvFHf8KuJZpp2ooNnFhXBcP": "bot burst 5",
  // Swap bots (scripts/swap-bots.ts): xDEX test traffic.
  C9twNM7uWWaEbBiWTMFNMTdUNWmYDVvyetRHdNrh1Tmm: "bot swap arb",
  "8qrLBCUuRFY19pQUvo5LiSxkXg5qDwGaSvcXm4D7CkZg": "bot swap random",
  "3vafojckSEfhHLZXoNnjBEkLboiEnLaHY3BY1McNCig7": "bot swap margin",
  HZr2HGBmaH7Gm4NCZkx5GGVJkouudRAk2ajr5XUyAuqA: "bot swap explorer",
};
