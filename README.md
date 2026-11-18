# Launch Radar — token-radar-01 entry

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/vinzagent/token-radar-01-entry/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/vinzagent/token-radar-01-entry/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar ranks every protocol that records no token yet by what its launch would be worth, and gives each one a concrete farm plan. The program reads the sealed DefiLlama snapshot, prices each pre-token protocol against what the market actually pays for launched peers in the same category (median market-cap/TVL, shrunk toward the global median when a category has few peers), then adjusts for seven-day TVL momentum, chain breadth and how long the protocol has run with no token. No protocol name is special-cased: one function prices every row, and the dashboard recomputes each row in the page so the board and the code visibly agree. One category rule stands in front of the pricing: a protocol filed as a Bridge or a Canonical Bridge is set aside, never ranked — its TVL is other protocols' assets in custody, not a product awaiting its own launch (WBTC, Bitcoin in a custodian's hands, is the snapshot rules' own example), and the house watchlist excludes both bridge categories for the same reason. The dashboard lists the set-aside bridges by name, with their count and combined TVL. The board covers the whole 40-protocol watchlist and the wider pre-token universe below its floor — 265 rows on this snapshot — each with a six-step farm plan that names the protocol's own chains, a capital size matched to its TVL tier, a cost and a time for every step.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22, standard library only, no install and no network. The program writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` (built with the vendored `vendor/makefun-board.ts`) into the output directory; two runs on the same snapshot write the same bytes.
