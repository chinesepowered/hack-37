# FloorCheck: walks every lot, every night

**Demo video (2:04):** [`demo/floorcheck-demo.mp4`](demo/floorcheck-demo.mp4)

**FloorCheck is an AI floor-plan auditor for equipment lenders.** It replaces the field audit: the recurring trip where an auditor drives lot to lot with a clipboard to confirm that every unit the lender financed is still there.

Floor-plan lenders pay for a dealer's inventory, and the dealer repays each advance when that unit sells. When a dealer sells a unit and keeps the money, the unit is **sold out of trust**, the classic floor-plan loss. Today lenders catch it with periodic on-site audits, usually weeks after the fact.

FloorCheck sends an always-on agent to every dealer's public inventory, every night:

1. **Agent37** runs the auditor: a Hermes agent with its own cloud computer and browser. It opens each dealer's inventory page, reads every listing and writes `listings.json` on its own disk.
2. The server pulls that file back through the Agent37 Files API and matches **every financed serial number** deterministically. The verdicts come from code, not from the LLM.
3. Exceptions stream to the dashboard as they're found:
   - **Sold out of trust:** listed SOLD while the advance is unpaid.
   - **Not found:** missing from the dealer's site, so it needs a spot check.
   - **Sale pending:** payoff is due when the sale closes.
   - **Collateral shortfall:** the unit is worth less than the advance.
4. Each exception carries evidence: the listing as published, its URL, a timestamp and a field-by-field match against the ledger.
5. One click each drafts the payoff demand to the dealer and the credit memo, and schedules a nightly **Agent37 cron** at 2 AM. The cron wakes the agent even if its computer is asleep.

In a real recorded run the agent audited 3 dealers and 47 listings in **46 seconds with 9 tool calls**. It caught 3 units sold out of trust ($262,400), 3 not found ($291,500) and 1 sale pending.

## Sponsors used

| Sponsor | How FloorCheck uses it |
|---|---|
| **Agent37** | Instance (Hermes auditor), streamed `POST /v1/responses` (every tool call is shown live), browser tools, Files API (`listings.json` read back), `exec` + public port (hosts the test dealer sites), **crons** (nightly audit) |
| **Monid** | `discover` picks the scraper live (`mrscraper/scrape/listing`); `scripts/fetch-comps.mjs` runs marketplace scrapes to collect market comps for collateral valuation |
| **OpenAI** | Structured outputs (strict JSON schema) repair the agent's listings if its file is missing or malformed; drafts the credit memo and payoff demands (template fallback without a key) |
| **InstaCloud** | Hosts the app (Dockerfile) and its Postgres audit history (`audit_runs`, `audit_findings`) |

## Run locally

```bash
npm install
cp .env.example .env   # add keys
npm start              # http://localhost:8080
```

- **Live mode** needs `AGENT37_API_KEY`, `AGENT37_INSTANCE_ID` and a public `DEALER_SITES_BASE` (or `PUBLIC_URL`) that the agent can browse.
- **Replay mode** (`/?mode=replay`) streams a recorded live run (`fixtures/replay.json`) through the same pipeline, so the demo works offline.

## Deploy on InstaCloud

```bash
npx -y insta@latest agent setup --create      # or: insta login --api-key insta_...
insta services add postgres db
insta services add compute app --always-on
insta secrets bind DATABASE_URL postgres/db --to compute/app
insta secrets set AGENT37_API_KEY             # repeat for AGENT37_INSTANCE_ID, OPENAI_API_KEY, MONID_API_KEY
insta deploy .
# then: insta secrets set PUBLIC_URL (the printed URL) and insta compute restart
```

With `PUBLIC_URL` set, the agent audits the dealer sites served by the app itself at `/dealers/<id>/`.

## Layout

- `server.js`: API, plus the event stream, schedule, memo and payoff-demand endpoints
- `lib/audit.js`: run orchestration (live via Agent37, or replay), matching, valuation, summary
- `lib/agent37.js`, `lib/openai.js`, `lib/monid.js`, `lib/store.js`: sponsor clients and Postgres
- `public/`: the dashboard (vanilla JS), dealer sites (`public/dealers/`), evidence captures
- `fixtures/`: the lender's ledger, dealer site contents, the recorded live run
- `scripts/`: dealer site builder, evidence capture, Monid comps refresh, demo video pipeline (ElevenLabs + Playwright + ffmpeg)

The dealers, lender and serial numbers are fictional test data. The agent runs, the browsing and the Monid calls are real.
