# SuperZoo scraper – review-only hardening

The GitHub Actions workflow is deliberately `workflow_dispatch`-only. It has read-only repository permissions and creates review artifacts under the runner's temporary directory. It never updates, commits, or pushes `products.json`, `superzoo-partner-foods.json`, or the Mazlíček+ catalog.

Local live review requires an explicit staging destination through the safe npm command:

```powershell
npm run scrape:review
npm run validate:raw
npm run convert:review
npm run validate:converted
npm run report:review
```

Tests are offline and use local HTML fixtures, including the real Playwright `page.evaluate` path:

```powershell
npm test
```

## Immutable baseline and thresholds

`test/fixtures/baselines/superzoo-legacy-1405.json` is the byte-identical, immutable legacy raw comparator source pinned by `config/safety-thresholds.json`. It came from the reviewed pre-hardening SuperZoo snapshot and has SHA-256 `DB5EB6C3338F50A3AE30FBB2DB6F3BEAB559A8867FA5E219952FA085A27B9DD8`. It is an audit/test fixture only: it is not the runtime catalog, the tracked 72-product `products.json`, or a live scrape output. Workflows and scripts must never rewrite or upload it as a success artifact.

The fixture reproduces the reviewed comparator deterministically: 1,405 legacy products become 1,377 after exactly 28 exclusions. Verify the fixture hash, exclusion transform, six category counts, and raw validation entirely offline with:

```powershell
npm run verify:baseline
```

Configured minima remain explicit: 1,124 total and category floors `625 / 16 / 223 / 40 / 101 / 121`. Any rejected card, unparseable card, duplicate source identity, or duplicate canonical URL/variant identity fails validation.

The exclusion contract pins all 35 runtime exclusion IDs and the 24 canonical SuperZoo URLs proven by the Mazlíček+ hard-remove report. The three Avicentra `manualReviewLater` IDs are a separate allowlist and are never active exclusions.

To change the comparator, retain the prior reviewed data, verify the source snapshot hash, review product/category and exclusion diffs, and update the fixture and contract in a dedicated reviewed change. A current scrape must never rewrite its own comparator or thresholds.
