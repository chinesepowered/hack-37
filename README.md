# FloorCheck: walks every lot, every night

**FloorCheck is an AI floor-plan auditor for equipment lenders.** Each night an always-on agent reads every dealer's public inventory and matches it against every serial number the lender financed. It flags units sold without the loan being repaid, with evidence a credit committee can act on. One audit of 3 dealers takes under a minute, instead of an auditor driving lot to lot.

**Live app:** https://prod-main-app-130d74-00j3gxx4m5q.compute.instacloud-edge.com

**Demo video:** https://www.youtube.com/watch?v=W7yFAcGtNXw

## The problem

Floor-plan lenders pay for a dealer's inventory, and the dealer repays each advance when that unit sells. When a dealer sells a unit and keeps the money, the unit is **sold out of trust**, the classic floor-plan loss. Today lenders catch it with periodic field audits: an auditor drives to each lot with a clipboard and checks serial numbers by hand. Audits are expensive, so they happen monthly or quarterly. The loss surfaces weeks after the money is gone.

## Our solution

1. An always-on **Agent37** agent opens each dealer's inventory page in its own browser every night. It reads every listing and writes them to `listings.json` on its own computer.
2. FloorCheck pulls that file back and matches **every financed serial number** in code, not by the LLM. Each unit comes out verified, sold out of trust, not found, or sale pending.
3. Every exception carries evidence: the listing as the dealer published it, its URL, a timestamp, and a field-by-field match against the loan ledger.
4. **Monid** pulls live marketplace comps for the exact model, so the lender sees what it would actually recover.
5. One click drafts the payoff demand to the dealer and the credit memo. The audit schedules itself to run nightly at 2 AM.

**Result from a real recorded run:** 3 farm equipment dealers and 47 listings audited in **40 seconds with 10 agent tool calls**. It found 3 units sold out of trust ($262,400), 3 not found ($291,500) and 1 sale pending. For the sold Bobcat T66, 7 live comps put recovery at $42,500 against a $71,400 advance.

## Sponsors

| Sponsor | What it does in FloorCheck |
|---|---|
| **Agent37** | Runs the auditor agent on its own always-on computer, with a browser, files and a nightly schedule |
| **Monid** | Finds and runs marketplace scrapers that price the collateral from live comps |
| **InstaCloud** | Hosts the app, with Postgres for the audit history |

### Agent37

- **Instance:** one Hermes agent instance (`agent37-hermes`) is the auditor, with a spending budget and always-on so the demo starts instantly.
- **Streamed turns:** `POST /v1/responses` with `stream: true`. Every reasoning step and tool call (`browser_navigate`, `browser_snapshot`, `write_file`, `terminal`) streams live to the dashboard.
- **Browser:** the agent's own headless browser reads each dealer's inventory page.
- **Files API:** `GET /v1/files/content` pulls the agent's `listings.json` off its computer for matching.
- **Exec + public ports:** `POST /v1/instances/{id}/exec` and `/public-ports` serve the test dealer sites from the instance at a public HTTPS URL.
- **Crons:** "Audit nightly" creates a platform cron (`0 2 * * *`, America/Los_Angeles). It wakes the agent even if its computer is asleep.

### Monid

- **Discover:** `POST /v1/discover` picks the scraper at runtime. During an audit the dashboard shows which endpoint it chose and its price.
- **Run:** `POST /v1/run` on `mrscraper/scrape/listing` extracts machine listings (title, price, year, hours) from marketplace search pages. `scripts/fetch-comps.mjs` collects the results into `fixtures/comps-live.json`.
- **Valuation:** the median comp for a model becomes its market value. That drives collateral coverage, loan-to-value per unit and the recovery value in each exception's evidence panel. It used 39 live listings for the Bobcat T66 and 21 for the Kubota L3902, for about $0.03 in total.

### InstaCloud

- **Compute:** the app deploys from its Dockerfile as an always-on compute service.
- **Postgres:** a managed database bound in as `DATABASE_URL`. Every audit run and finding is written to `audit_runs` and `audit_findings`, which back the History tab.

## Run it

```bash
pnpm install
cp .env.example .env   # add keys
pnpm start             # http://localhost:8080
```

- **Live mode** needs `AGENT37_API_KEY`, `AGENT37_INSTANCE_ID` and a public `DEALER_SITES_BASE` (or `PUBLIC_URL`) the agent can browse.
- **Replay mode** (`/?mode=replay`) streams the recorded live run (`fixtures/replay.json`) through the same pipeline. Use it when there's no network.

## Layout

- `server.js`: API, live event stream, schedule, memo and payoff-demand endpoints
- `lib/audit.js`: run orchestration (live on Agent37, or replay), serial matching, valuation, summary
- `lib/agent37.js`, `lib/monid.js`, `lib/store.js`: sponsor clients and Postgres
- `public/`: the dashboard (vanilla JS), test dealer sites (`public/dealers/`), evidence captures
- `fixtures/`: the lender's ledger, dealer site contents, the recorded live run, live comps
- `scripts/`: dealer site builder, evidence capture, Monid comps refresh, demo video pipeline
- `pitch.html`: 4-slide pitch deck

_The dealers, lender and serial numbers are fictional test data. The agent runs, the browsing and the market comps are real._
