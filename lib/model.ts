// Launch Radar's model: one sealed snapshot of the protocol universe in, one ranked board out.
//
// The idea in one paragraph. A protocol that records no token has no price, but the snapshot is full of
// protocols that did launch: for each of those, market cap divided by TVL is what the market actually
// paid per dollar of TVL in that line of business. Launch Radar prices every pre-token protocol against
// its own category's launched peers — the median peer multiple, with each peer's ratio winsorised so
// one micro-cap cannot bend a category, and shrunk toward the global median when a category has few
// peers to learn from. Three adjustments follow, all from the snapshot's own figures: seven-day TVL
// momentum (a protocol gathering TVL is gathering the users a launch rewards), chain breadth (each
// extra chain is another community a token would drop to), and a track-record factor from the day
// DefiLlama first listed the protocol (years of running at scale with no token is evidence of both
// staying power and an unrewarded user base; a protocol listed last month gets a discount instead).
//
// No protocol name is ever special-cased. The same functions price every row, the dashboard restates
// the arithmetic, and the page recomputes each row from the factors board.json carries.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ------------------------------------------------------------------ constants

/** The model's version label: the dashboard names it and the board carries it. */
export const MODEL_VERSION = 'launch-radar-2';

/** A peer's market-cap/TVL ratio is winsorised into this band before any median is taken. */
export const PEER_RATIO_MIN = 0.01;
export const PEER_RATIO_MAX = 4;
/** No category multiple, however strong its peers, is applied above this cap. */
export const MULTIPLE_CAP = 3;
/** Shrinkage: a category median is blended with the global median as if the global had this many peers. */
export const SHRINK_PEERS = 6;
/** Seven-day TVL growth is clamped to this band before it moves a price. */
export const GROWTH_FLOOR = -50;
export const GROWTH_CAP = 60;
/** Momentum: implied value moves by this share of the clamped growth. */
export const GROWTH_WEIGHT = 0.6;
/** Breadth: each doubling of the chain count adds this share. */
export const BREADTH_PER_DOUBLING = 0.04;
/** Track record: the factor runs from AGE_BASE (just listed) to AGE_BASE + AGE_RANGE (at AGE_DAYS_CAP). */
export const AGE_BASE = 0.85;
export const AGE_RANGE = 0.3;
export const AGE_DAYS_CAP = 1460;
/** How many live-token protocols the dashboard's set-aside view carries, by market cap. */
export const LIVE_ROWS = 24;

// ------------------------------------------------------------------ snapshot

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ------------------------------------------------------------------ the universe

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a later version of another product. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped, staked or staking: a product of an asset that already trades, not a launch. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** A name that begins with an exchange's: the exchange's own product line, not an independent launch. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * Whether a protocol is one the board may rank: it records no token, and its name does not mark it as
 * a version of another product, a wrapped or staked product of a trading asset, or an exchange's own
 * line. These are the snapshot README's name tests for the watchlist, applied without its TVL floor
 * and without dropping whole categories: a bridge or an exchange that records no token is still a
 * candidate, and the market's own low multiples for those categories price it (see peerMultiples).
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !VERSIONED.test(p.name) && !WRAPPED_WORD.test(p.name) && !EXCHANGE_PREFIX.test(p.name);
}

// ------------------------------------------------------------------ peer multiples

const clampRatio = (x: number): number => Math.min(PEER_RATIO_MAX, Math.max(PEER_RATIO_MIN, x));

/** The median of a non-empty list, exact: the middle value, or the mean of the two middle ones. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** One category's pricing evidence: how many launched peers, their median ratio, the multiple applied. */
export interface CategoryMultiple {
  category: string;
  peers: number;
  peer_median: number | null;
  multiple: number;
}

/** What the market pays per TVL dollar, learned from the snapshot's launched protocols. */
export interface PeerModel {
  /** The winsorised median ratio across every launched protocol with a market cap and TVL. */
  global_median: number;
  /** Launched protocols that carry both a market cap and a TVL: the evidence base. */
  peer_count: number;
  /** Per-category multiples, keyed by category name ('Uncategorized' when DefiLlama names none). */
  by_category: Map<string, CategoryMultiple>;
}

const categoryOf = (p: SnapshotProtocol): string => p.category ?? 'Uncategorized';

/**
 * The peer model: for every category, the median market-cap/TVL of its launched protocols (each ratio
 * winsorised to [PEER_RATIO_MIN, PEER_RATIO_MAX]), blended with the global median by shrinkage —
 * multiple = (peers x category median + SHRINK_PEERS x global median) / (peers + SHRINK_PEERS),
 * capped at MULTIPLE_CAP. A category with no launched peers prices at the global median.
 */
export function peerMultiples(snapshot: Snapshot): PeerModel {
  const launched = snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.tvl_usd > 0);
  const globalMedian = median(launched.map((p) => clampRatio(p.mcap_usd! / p.tvl_usd)));
  const ratios = new Map<string, number[]>();
  for (const p of launched) {
    const key = categoryOf(p);
    const list = ratios.get(key);
    if (list === undefined) ratios.set(key, [clampRatio(p.mcap_usd! / p.tvl_usd)]);
    else list.push(clampRatio(p.mcap_usd! / p.tvl_usd));
  }
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [category, list] of ratios) {
    const med = median(list);
    const blended = (list.length * med + SHRINK_PEERS * globalMedian) / (list.length + SHRINK_PEERS);
    byCategory.set(category, { category, peers: list.length, peer_median: med, multiple: Math.min(MULTIPLE_CAP, blended) });
  }
  return { global_median: globalMedian, peer_count: launched.length, by_category: byCategory };
}

/** The multiple one protocol is priced with, and the evidence behind it. */
export function multipleFor(model: PeerModel, p: SnapshotProtocol): CategoryMultiple {
  return model.by_category.get(categoryOf(p)) ?? { category: categoryOf(p), peers: 0, peer_median: null, multiple: model.global_median };
}

// ------------------------------------------------------------------ the factors

const DAY_MS = 86_400_000;

/** Whole days from the day DefiLlama first tracked the protocol to the snapshot's day; null if unlisted. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** One protocol's full pricing: every factor named, so the dashboard can show the working. */
export interface Pricing {
  implied: number;
  multiple: number;
  peer_count: number;
  peer_median: number | null;
  growth_pct: number;
  momentum_factor: number;
  breadth_factor: number;
  age_days: number | null;
  age_factor: number;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Price one pre-token protocol: TVL x category multiple x momentum x breadth x track record. */
export function price(p: SnapshotProtocol, asOf: string, peers: PeerModel): Pricing {
  const cm = multipleFor(peers, p);
  const growthPct = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, p.change_7d ?? 0));
  const momentum = 1 + (growthPct / 100) * GROWTH_WEIGHT;
  const breadth = 1 + BREADTH_PER_DOUBLING * Math.log2(Math.max(1, p.chains.length));
  const age = ageDays(asOf, p.listed_at);
  const ageFactor = age === null ? 1 : AGE_BASE + (Math.min(age, AGE_DAYS_CAP) / AGE_DAYS_CAP) * AGE_RANGE;
  const implied = Math.max(1, Math.round(p.tvl_usd * cm.multiple * momentum * breadth * ageFactor));
  return {
    implied,
    multiple: round4(cm.multiple),
    peer_count: cm.peers,
    peer_median: cm.peer_median === null ? null : round4(cm.peer_median),
    growth_pct: growthPct,
    momentum_factor: round4(momentum),
    breadth_factor: round4(breadth),
    age_days: age,
    age_factor: round4(ageFactor),
  };
}

// ------------------------------------------------------------------ farm plans

/** A small deterministic hash of a slug: the rotation that keeps 300 plans from reading copy-pasted. */
function slugHash(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Pick a template variant deterministically: the slug's hash, shifted per step so steps vary independently. */
function pick<T>(variants: readonly T[], hash: number, salt: number): T {
  return variants[(hash >>> (salt * 5)) % variants.length]!;
}

/** Chains where an ordinary transaction costs cents, not dollars: gas wording follows the chain. */
const LOW_FEE_CHAINS = new Set([
  'Arbitrum', 'Base', 'Optimism', 'Polygon', 'Solana', 'BSC', 'Avalanche', 'zkSync Era', 'Linea', 'Scroll',
  'Mantle', 'Blast', 'Mode', 'Fantom', 'Gnosis', 'Celo', 'Moonbeam', 'Metis', 'Taiko', 'Sonic', 'Berachain',
]);

/** What one ordinary transaction costs on a chain, in words. */
function gasFor(chain: string): string {
  if (chain === 'Ethereum') return 'about $10 of gas';
  if (LOW_FEE_CHAINS.has(chain)) return 'about $1 of gas';
  return 'about $3 of gas';
}

/** The facts a farm plan is written from: the protocol's own record, nothing else. */
interface FarmContext {
  name: string;
  chain: string;
  chain2: string;
  multi: boolean;
  capital: number;
  gas: string;
  hold: number;
}

/** How much capital one farm position needs, from the protocol's own TVL: bigger protocols, bigger ticket. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  if (p.tvl_usd >= 10_000_000) return 50;
  return 25;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function farmContext(p: SnapshotProtocol, age: number | null): FarmContext {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  return {
    name: p.name,
    chain,
    chain2: p.chains.length > 1 ? p.chains[1]! : chain,
    multi: p.chains.length > 1,
    capital: capitalFor(p),
    gas: gasFor(chain),
    hold: holdDaysFor(age),
  };
}

/** Fill a template's {name}, {chain}, {chain2}, {cap}, {hold} and {gas} from the context. */
function fill(template: string, ctx: FarmContext): string {
  return template
    .replaceAll('{name}', ctx.name)
    .replaceAll('{chain2}', ctx.chain2)
    .replaceAll('{chain}', ctx.chain)
    .replaceAll('{cap}', String(ctx.capital))
    .replaceAll('{hold}', String(ctx.hold))
    .replaceAll('{gas}', ctx.gas);
}

/** A category's playbook: the opening position, the second leg, and the recurring action. */
interface Playbook {
  open: readonly string[];
  deepen: readonly string[];
  cadence: readonly { text: string; cost: string; time: string }[];
}

const GENERIC: Playbook = {
  open: [
    "Put ${cap} to work in {name}'s core product on {chain}: use the action its own page leads with — a deposit, a vault or a pool — and keep the position open.",
    "Start with ${cap} in {name}'s flagship product on {chain}, the one its own page features first, and leave the position untouched once it is open.",
  ],
  deepen: [
    "Add a second, smaller position in another of {name}'s products on {chain2}, so the wallet's history is broader than a single transaction.",
    "Open the second leg: a different product or market of {name}'s on {chain2}, at about half the first position's size.",
  ],
  cadence: [
    { text: "Return weekly for one small, ordinary action — a top-up, a claim or a vote — and keep the streak unbroken for the whole qualifying window.", cost: 'one small transaction a week ({gas})', time: '10 minutes a week' },
    { text: "Once a week, do one small thing on {name} (top up, claim, or adjust the position); consistency across weeks is the signal, not size.", cost: 'one small transaction a week ({gas})', time: '10 minutes a week' },
  ],
};

/** Playbooks by DefiLlama category. Each is written from the category's mechanics, then filled per protocol. */
const PLAYBOOKS: Record<string, Playbook> = {
  Dexs: {
    open: [
      "Add ${cap} of liquidity to a core pair on {name} ({chain}) and leave it through at least one weekly fee snapshot.",
      "Swap through {name} on {chain} in ordinary size — at least ${cap} of volume across several pairs, not one round trip — so the activity reads as real usage.",
    ],
    deepen: [
      "Split the position: keep half in the pool and route the rest of your swaps through {name} on {chain2}, building a second trail of activity.",
      "Provide liquidity in a second pair on {name} ({chain2}) at about half the size, so the wallet is a liquidity provider, not a passer-by.",
    ],
    cadence: [
      { text: "Trade on {name} at least three times a week in ordinary size; consistent weeks count for more than one large day.", cost: 'two or three swaps a week ({gas} each)', time: '10 minutes, three times a week' },
      { text: "Keep a weekly rhythm: two or three swaps and one liquidity adjustment on {name}, every week of the window.", cost: 'two or three swaps a week ({gas} each)', time: '10 minutes, three times a week' },
    ],
  },
  Lending: {
    open: [
      "Supply ${cap} of USDC (or the chain's main stablecoin) to {name} on {chain} and leave the deposit untouched.",
      "Open a supply position of ${cap} in {name}'s main market on {chain}; choose the market its own page leads with.",
    ],
    deepen: [
      "Borrow a conservative share against the deposit — under a third of its value — and redeposit it once, then stop: one clean loop, no leverage spiral.",
      "Draw one small borrow against the supply and repay it in full inside the month, so the wallet shows both sides of the market.",
    ],
    cadence: [
      { text: "Repay and re-borrow a small amount monthly, and claim any supplier incentives {name} publishes, so the wallet shows an ongoing lending relationship.", cost: 'one transaction a month ({gas})', time: '15 minutes a month' },
      { text: "Once a month, adjust the position — a top-up or a partial repay — and claim whatever rewards {name} shows for the account.", cost: 'one transaction a month ({gas})', time: '15 minutes a month' },
    ],
  },
  CDP: {
    open: [
      "Open a vault on {name} ({chain}): lock ${cap} of collateral and mint a modest amount of its stablecoin against it, well inside the liquidation line.",
      "Start a collateral position of ${cap} on {name} ({chain}) and mint against it at no more than half the maximum ratio.",
    ],
    deepen: [
      "Hold or deploy the minted stablecoin inside {name}'s own ecosystem on {chain} instead of selling it, so both sides of the position are visible.",
      "Open a second, smaller vault with a different collateral type if {name} offers one, at about half the first vault's size.",
    ],
    cadence: [
      { text: "Top up or trim the vault monthly to keep the collateral ratio steady as prices move; an actively managed vault is the signal.", cost: 'one adjustment a month ({gas})', time: '10 minutes a week to check, one adjustment a month' },
      { text: "Check the vault weekly and adjust once a month; a vault that survives a volatile week unmanaged-by-luck is worth more than a fresh one.", cost: 'one adjustment a month ({gas})', time: '10 minutes a week to check, one adjustment a month' },
    ],
  },
  Derivatives: {
    open: [
      "Deposit ${cap} of margin on {name} ({chain}) and open one small position in its most liquid market; size it to learn the venue, not to punt.",
      "Fund a margin account on {name} ({chain}) with ${cap} and trade its flagship market in small size.",
    ],
    deepen: [
      "Add a second, hedged leg, or provide to {name}'s counterparty vault if it offers one, so the account carries both trader and liquidity history.",
      "Trade a second market on {name} (a different pair or expiry) at half size, so the account is not a one-market account.",
    ],
    cadence: [
      { text: "Trade small size at least twice a week and keep the margin account funded between sessions; venues reward persistent accounts over one-off volume.", cost: 'the margin stays on the venue; trading fees on small size', time: 'two short sessions a week' },
      { text: "Keep two sessions a week on {name} for the whole window, and never let the account sit empty between them.", cost: 'the margin stays on the venue; trading fees on small size', time: 'two short sessions a week' },
    ],
  },
  Yield: {
    open: [
      "Deposit ${cap} into {name}'s flagship vault on {chain} and keep the vault shares in the same wallet.",
      "Put ${cap} into the main strategy {name} runs on {chain} — the one its own page lists first — and hold the shares.",
    ],
    deepen: [
      "Add a second vault on {chain2} if {name} runs there, or a second strategy on {chain}, so the wallet holds more than one of its products.",
      "Split the position across two of {name}'s vaults with different strategies, about two-thirds and one-third.",
    ],
    cadence: [
      { text: "Compound or top up monthly rather than withdrawing yield; a growing, untouched position is the pattern launches in this category have rewarded.", cost: 'one transaction a month ({gas})', time: '10 minutes a month' },
      { text: "Reinvest the yield monthly and leave the principal alone; the compounding trail is the history that counts.", cost: 'one transaction a month ({gas})', time: '10 minutes a month' },
    ],
  },
  Bridge: {
    open: [
      "Bridge ${cap} of USDC from Ethereum to {chain} through {name}, then use the bridged funds in an app on the far side instead of bridging straight back.",
      "Move ${cap} across {name} to {chain} and spend or deposit it there; a bridge farm is the activity on both ends, not the hop alone.",
    ],
    deepen: [
      "Bridge a second asset, or a second route with {name} (for example back via {chain2}), building a two-way history rather than a single hop.",
      "Make the return trip on a different day and a different route {name} offers, so the history shows a user, not a script.",
    ],
    cadence: [
      { text: "Make one genuine cross-chain move a month through {name}; bridges count distinct wallets and repeat routes, not one large transfer.", cost: 'one bridge a month (bridge fees plus {gas})', time: '15 minutes a month' },
      { text: "Bridge monthly in ordinary size and keep using the funds on the far chain between moves.", cost: 'one bridge a month (bridge fees plus {gas})', time: '15 minutes a month' },
    ],
  },
  'Liquid Staking': {
    open: [
      "Stake ${cap} of the chain's staking asset through {name} on {chain} and hold the liquid receipt token in the staking wallet.",
      "Convert ${cap} into {name}'s liquid staking token on {chain} through its own page and keep the receipt unspent.",
    ],
    deepen: [
      "Put the receipt token to work in one integrated venue {name} lists (a lending market or a pool on {chain}), keeping the whole trail attributable to the same wallet.",
      "Stake a second, smaller amount from a different chain {name} supports ({chain2}), so the wallet stakes in two places.",
    ],
    cadence: [
      { text: "Add a small amount to the stake monthly; a stake that only grows reads very differently from one parked and forgotten.", cost: 'one transaction a month ({gas})', time: '10 minutes a month' },
      { text: "Top the stake up monthly and claim any staking rewards through {name}'s own page, never a third-party link.", cost: 'one transaction a month ({gas})', time: '10 minutes a month' },
    ],
  },
  'Risk Curators': {
    open: [
      "Deposit ${cap} into a vault curated through {name} on {chain} — pick its flagship vault, the one its own page leads with.",
      "Place ${cap} in the largest vault {name} curates on {chain}; curator risk is the product, so choose its core vault, not an exotic one.",
    ],
    deepen: [
      "Hold a second, smaller position in another {name} vault with a different strategy, so the wallet is exposed to the curator, not one pool.",
      "Add a position in a {name} vault on {chain2} if it curates there, at about half the first deposit.",
    ],
    cadence: [
      { text: "Review the position monthly and stay through at least one full reporting cycle; curator launches have historically favoured wallets that held through volatility.", cost: 'one transaction a month ({gas})', time: '15 minutes a month' },
      { text: "Check the vault's reporting monthly and top up on schedule rather than after good weeks.", cost: 'one transaction a month ({gas})', time: '15 minutes a month' },
    ],
  },
  'Onchain Capital Allocator': {
    open: [
      "Deposit ${cap} into {name}'s main allocation vault on {chain} and keep the shares in the depositing wallet.",
      "Fund {name}'s flagship strategy on {chain} with ${cap}; allocators reward the wallets that fund the strategy, not the audience.",
    ],
    deepen: [
      "Hold a second allocation — a different strategy of {name}'s, or the same one on {chain2} — at about half the size.",
      "Stay through one full reallocation cycle so the wallet's history includes the strategy changing under it.",
    ],
    cadence: [
      { text: "Top up monthly on a fixed schedule and never withdraw mid-cycle; steady funding is the behaviour this category's launches have rewarded.", cost: 'one transaction a month ({gas})', time: '15 minutes a month' },
      { text: "Review monthly, add on schedule, and let at least one full strategy cycle complete before judging the position.", cost: 'one transaction a month ({gas})', time: '15 minutes a month' },
    ],
  },
  CEX: {
    open: [
      "Open an account with {name}, complete its verification, and keep a balance of about ${cap} on the exchange rather than passing funds straight through.",
      "Register with {name}, verify the account, and make a first deposit of about ${cap} that stays on the platform.",
    ],
    deepen: [
      "Use two of {name}'s products — spot trading plus its earn or staking product — so the account shows a customer relationship, not a single deposit.",
      "Hold part of the balance in {name}'s earn product and trade the rest on spot, so the account uses the platform's range.",
    ],
    cadence: [
      { text: "Trade modest size a few times a month and keep the account active between campaigns; exchanges that launch tokens reward account age and steady activity.", cost: 'trading fees on modest size, about $5 a month', time: '15 minutes a few times a month' },
      { text: "Log in and trade monthly at minimum; dormant accounts are the first filtered out of exchange launches.", cost: 'trading fees on modest size, about $5 a month', time: '15 minutes a few times a month' },
    ],
  },
  RWA: {
    open: [
      "Mint or buy ${cap} of {name}'s yield asset on {chain} through its own app and hold it in the minting wallet.",
      "Complete {name}'s onboarding and take a ${cap} position in its flagship real-world-asset product on {chain}.",
    ],
    deepen: [
      "Hold the position through a full distribution cycle so at least one yield payment lands in the wallet.",
      "Add a second product of {name}'s if it offers one (a different asset or term) at about half the size.",
    ],
    cadence: [
      { text: "Add to the position quarterly and keep the account record current; real-world-asset launches favour verified, long-held accounts.", cost: 'one transaction a quarter ({gas})', time: '20 minutes a quarter' },
      { text: "Review quarterly, stay through each distribution, and keep verification documents up to date.", cost: 'one transaction a quarter ({gas})', time: '20 minutes a quarter' },
    ],
  },
  Chain: {
    open: [
      "Bridge ${cap} to {name}'s chain and make it your active chain for a month: hold its gas token and transact there weekly.",
      "Move ${cap} onto {name}'s chain and set up there properly — gas token, a wallet history, and a first swap — rather than visiting once.",
    ],
    deepen: [
      "Use at least three native apps on the chain (a swap venue, a lending market, and one more), so the wallet is a chain citizen, not a bridge tourist.",
      "Hold a small position in two native protocols on the chain alongside the gas balance.",
    ],
    cadence: [
      { text: "Keep a weekly transaction streak on the chain; chain launches reward breadth and duration of native activity over size.", cost: '{gas} a transaction, a few a week', time: '10 minutes a week' },
      { text: "Transact weekly and hold a small name registration or ecosystem NFT if the chain offers one.", cost: '{gas} a transaction, a few a week', time: '10 minutes a week' },
    ],
  },
  'Prediction Market': {
    open: [
      "Fund {name} with ${cap} and take positions in at least three unrelated markets, sized small enough to hold to resolution.",
      "Deposit ${cap} on {name} and spread it across several markets instead of concentrating on one event.",
    ],
    deepen: [
      "Provide liquidity, or take the thin side, in one illiquid market where a new participant visibly adds depth.",
      "Let at least one position resolve and settle; a settled history is worth more than open bets.",
    ],
    cadence: [
      { text: "Trade every week the venue is active and let positions resolve; resolved, settled history outweighs open exposure.", cost: 'the positions themselves; no fee beyond trading spreads', time: '15 minutes a week' },
      { text: "Place or adjust one position a week and keep a record of every settlement.", cost: 'the positions themselves; no fee beyond trading spreads', time: '15 minutes a week' },
    ],
  },
  Insurance: {
    open: [
      "Buy ${cap} of cover from {name} on {chain} for a position you actually hold, and keep the policy to expiry.",
      "Take out a policy through {name} on {chain} sized to a real position (about ${cap} of cover), not a token amount.",
    ],
    deepen: [
      "Stake into {name}'s capital pool as well if it offers one, so the wallet appears on both sides of the market.",
      "Cover a second position or a second protocol risk through {name} at half the first policy's size.",
    ],
    cadence: [
      { text: "Renew the cover when it lapses; continuous coverage history is the signal in this category.", cost: 'the premium on renewal', time: '10 minutes a month' },
      { text: "Review cover monthly and renew before expiry so there is no gap in the history.", cost: 'the premium on renewal', time: '10 minutes a month' },
    ],
  },
};

PLAYBOOKS['Yield Aggregator'] = PLAYBOOKS.Yield!;
PLAYBOOKS['Canonical Bridge'] = PLAYBOOKS.Bridge!;
PLAYBOOKS['Cross Chain Bridge'] = PLAYBOOKS.Bridge!;
PLAYBOOKS['Liquid Restaking'] = PLAYBOOKS['Liquid Staking']!;
PLAYBOOKS.Restaking = PLAYBOOKS['Liquid Staking']!;
PLAYBOOKS['Staking Pool'] = PLAYBOOKS['Liquid Staking']!;
PLAYBOOKS['CDP Manager'] = PLAYBOOKS.CDP!;

/** The playbook one protocol is farmed by: its category's, or the generic one its record composes. */
function playbookFor(p: SnapshotProtocol): Playbook {
  if (p.category !== null && PLAYBOOKS[p.category] !== undefined) return PLAYBOOKS[p.category]!;
  return GENERIC;
}

/** One farm step as one string: the action, then its cost and time, within the gate's 20..600 characters. */
function stepString(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

const SETUP_STEPS: readonly string[] = [
  "Start with a fresh wallet dedicated to {name}: fund it with the gas token on {chain} and keep its seed phrase offline and written down.",
  "Use one wallet for {name} and nothing else, funded on {chain}; a clean, single-purpose wallet makes the whole farm attributable.",
  "Set up a separate wallet for this farm and bridge its gas money to {chain} first, before any position is opened.",
];

const WATCH_STEPS: readonly string[] = [
  "Track {name}'s official announcements and claim any launch allocation only from links the protocol itself publishes; keep a dated log of every step above.",
  "Keep a farm log — wallet, dates, amounts, transaction hashes — and re-check {name}'s official channels monthly, so a claim window finds the history ready.",
];

/**
 * A protocol's farm plan: six steps — set up, open the category's position, add the second leg, keep a
 * cadence, hold for the qualifying window, and watch for the claim. Every step is composed from the
 * protocol's own record (category, chains, TVL tier, age) with its cost and its time; the wording
 * rotates deterministically by slug so no two hundred plans read alike.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const ctx = farmContext(p, age);
  const h = slugHash(p.slug);
  const book = playbookFor(p);
  const holdText = ctx.multi
    ? `Repeat the core position on {chain2} with a smaller amount, and hold both positions for at least {hold} days without withdrawing.`
    : `Hold the position for at least {hold} days without withdrawing; duration across weekly snapshots is what separates farmers from passers-by.`;
  const cadence = pick(book.cadence, h, 3);
  return [
    stepString(fill(pick(SETUP_STEPS, h, 0), ctx), 'the gas token only, under $5 to set up', '10 minutes'),
    stepString(fill(pick(book.open, h, 1), ctx), `$${ctx.capital} of capital plus ${ctx.gas}`, '15 minutes to set up'),
    stepString(fill(pick(book.deepen, h, 2), ctx), `about half the first position, plus ${ctx.gas}`, '15 minutes'),
    stepString(fill(cadence.text, ctx), fill(cadence.cost, ctx), cadence.time),
    stepString(fill(holdText, ctx), ctx.multi ? 'a second, smaller position (about half the first)' : 'the capital stays in the position', `${ctx.hold} days`),
    stepString(fill(pick(WATCH_STEPS, h, 4), ctx), 'nothing; never pay to claim', '5 minutes a month'),
  ];
}

// ------------------------------------------------------------------ the board

/** One row of board.json: the ranked board's row, with the model's working shown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    peer_count: number;
    peer_median: number | null;
    growth_pct: number;
    momentum_factor: number;
    breadth_factor: number;
    age_factor: number;
  };
  farm_steps: string[];
}

/**
 * The board: every rankable protocol — the whole watchlist plus the wider pre-token universe the name
 * tests leave — priced, sorted by implied value (ties: TVL, then slug), and ranked 1..N.
 */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const peers = peerMultiples(snapshot);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => ({ p, pricing: price(p, snapshot.as_of, peers) }));
  scored.sort(
    (a, b) =>
      b.pricing.implied - a.pricing.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.pricing.age_days,
    watchlist: watch.has(s.p.slug),
    implied_value_usd: s.pricing.implied,
    model: {
      category_multiple: s.pricing.multiple,
      peer_count: s.pricing.peer_count,
      peer_median: s.pricing.peer_median,
      growth_pct: s.pricing.growth_pct,
      momentum_factor: s.pricing.momentum_factor,
      breadth_factor: s.pricing.breadth_factor,
      age_factor: s.pricing.age_factor,
    },
    farm_steps: farmSteps(s.p, s.pricing.age_days),
  }));
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows, outside 100..4000`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} outranks rank ${i} on implied value`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (r.name.trim() === '') return `${r.slug} has an empty name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

// ------------------------------------------------------------------ the dashboard's data

/** A live-token protocol: it already trades, so the page shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

/** The live-token protocols, by market cap, for the dashboard's set-aside view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd !== null && p.tvl_usd > 0 ? Math.round((p.mcap_usd / p.tvl_usd) * 100) / 100 : null,
    }));
}

/** One category's line in the dashboard's methodology table. */
export interface CategoryLine {
  category: string;
  rows: number;
  peers: number;
  peer_median: number | null;
  multiple: number;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: {
    global_median: number;
    peer_count: number;
    shrink_peers: number;
    growth_floor: number;
    growth_cap: number;
    growth_weight: number;
  };
  stats: {
    protocols: number;
    pre_token: number;
    ranked: number;
    watchlist_size: number;
    total_implied_usd: number;
    total_tvl_usd: number;
    top_category: string;
  };
  categories: CategoryLine[];
  rows: BoardRow[];
  live: LiveRow[];
}

/** Everything the dashboard needs: the board, the live set, the category evidence, and the model. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const peers = peerMultiples(snapshot);
  const live = liveRows(snapshot);
  const lines = new Map<string, CategoryLine>();
  for (const row of board) {
    const key = row.category ?? 'Uncategorized';
    const line = lines.get(key);
    if (line !== undefined) line.rows += 1;
    else {
      const cm = peers.by_category.get(key);
      lines.set(key, {
        category: key,
        rows: 1,
        peers: cm?.peers ?? 0,
        peer_median: cm?.peer_median ?? null,
        multiple: row.model.category_multiple,
      });
    }
  }
  const categories = [...lines.values()].sort((a, b) => b.rows - a.rows || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: {
      global_median: round4(peers.global_median),
      peer_count: peers.peer_count,
      shrink_peers: SHRINK_PEERS,
      growth_floor: GROWTH_FLOOR,
      growth_cap: GROWTH_CAP,
      growth_weight: GROWTH_WEIGHT,
    },
    stats: {
      protocols: snapshot.protocols.length,
      pre_token: snapshot.protocols.filter(isPreToken).length,
      ranked: board.length,
      watchlist_size: snapshot.watchlist.length,
      total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
      total_tvl_usd: board.reduce((n, r) => n + r.tvl_usd, 0),
      top_category: categories.length > 0 ? categories[0]!.category : 'none',
    },
    categories,
    rows: board,
    live,
  };
  return { board, radar };
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
