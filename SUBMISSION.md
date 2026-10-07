# FloorCheck: hackathon submission

**Project name:** FloorCheck: walks every lot, every night

**Workflow we replaced:** the floor-plan field audit. Lenders that finance a dealer's inventory (equipment, autos, RVs) send auditors to physically confirm that every financed unit is still on the lot. They're hunting for units **sold out of trust**: the dealer sold the unit and kept the lender's money. Audits are periodic, manual and expensive, and the loss usually surfaces weeks late.

**What FloorCheck does:** an always-on Agent37 agent visits every dealer's public inventory every night. It reads every listing in its own browser and writes `listings.json` on its own computer. FloorCheck then pulls the file back and matches every financed serial number deterministically. It flags units sold out of trust, missing or sale-pending, each with evidence: the listing as published, its URL, a timestamp and a field-by-field ledger match. It prices recovery value from live marketplace comps through Monid, drafts payoff demands and the credit memo, and schedules itself to run nightly at 2 AM.

**Result (real recorded run):** 3 farm equipment dealers and 47 listings audited in **40 seconds with 10 agent tool calls**. It found $262,400 sold out of trust, $291,500 not found and one sale pending. For the sold Bobcat T66, 7 live comps put recovery at about $42.5K against a $71.4K advance.

**Sponsor integrations:**
- **Agent37 Cloud APIs:** a Hermes instance as the auditor, streamed `/v1/responses` with every tool call shown live, browser tools, the Files API to read back `listings.json`, `exec` and a public port to host the test dealer sites, and a **cron** for the nightly audit.
- **Monid:** `discover` picks the scraper; `mrscraper/scrape/listing` runs pulled real marketplace comps for collateral recovery value.
- **InstaCloud:** hosts the app (Dockerfile) with Postgres for the audit history.

**Links:**
- Repo: https://github.com/chinesepowered/hack-37
- Demo video: _(upload `floorcheck-demo.mp4` and paste link)_
- Live app: _(InstaCloud URL after deploy)_

_The dealers, lender and serial numbers are fictional test data. The agent runs, the browsing and the Monid scrapes are real._
