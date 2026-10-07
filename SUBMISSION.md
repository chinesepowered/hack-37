# FloorCheck: hackathon submission

**Project name:** FloorCheck: walks every lot, every night

**Links:**
- Repo: https://github.com/chinesepowered/hack-37
- Demo video: _(paste link)_
- Live app: https://prod-main-app-130d74-00j3gxx4m5q.compute.instacloud-edge.com

## 1) What does your agent do, and which workflow does it improve?

FloorCheck is an AI floor-plan auditor for equipment lenders. It replaces the **floor-plan field audit**. Lenders that finance a dealer's inventory (tractors, farm and ranch equipment) send auditors to drive lot to lot and confirm, serial by serial, that every financed unit is still there. They're hunting for units **sold out of trust**: the dealer sold the unit and kept the lender's money. Audits are manual and expensive, so they happen monthly or quarterly, and the loss surfaces weeks late.

FloorCheck's always-on agent does the audit every night instead:
- It opens every dealer's public inventory page in its own browser and reads every listing. Then it writes what it found to `listings.json` on its own computer.
- FloorCheck pulls that file back and matches every financed serial number in code. Each unit comes out verified, sold out of trust, not found, or sale pending.
- Every exception carries evidence: the listing as the dealer published it, its URL, a timestamp, and a field-by-field match against the loan ledger.
- It prices recovery value from live marketplace comps.
- It drafts the payoff demand to each dealer and the credit memo.
- It schedules itself to run nightly at 2 AM.

**Result from a real recorded run:** 3 farm equipment dealers and 47 listings audited in **40 seconds with 10 agent tool calls**. It found $262,400 sold out of trust (3 units), $291,500 not found (3 units) and 1 sale pending. For the sold Bobcat T66, 7 live comps put recovery at $42,500 against a $71,400 advance. An audit that takes an auditor days of driving now runs in under a minute, every night.

## 2) Describe your Agent37 Cloud API integration and any OpenAI, Supabase, InstaCloud, or Monid integrations

**Agent37 Cloud APIs** run the auditor:
- **Instances:** `POST /v1/instances` creates an `agent37-hermes` instance with a managed-spend budget, kept always-on so audits start instantly.
- **Streamed turns:** `POST /v1/responses` with `stream: true` dispatches each audit. The named SSE events (reasoning, `tool_call.started` / `completed`, `completed` with usage) stream live into our dashboard, so you watch the agent call `browser_navigate`, `browser_snapshot`, `write_file` and `terminal` as it works.
- **Browser:** the agent's own browser reads each dealer's inventory page.
- **Files API:** `GET /v1/files/content` pulls the agent's `listings.json` off its computer for matching, and `PUT` uploaded the test dealer sites to it.
- **Exec + public ports:** `POST /v1/instances/{id}/exec` starts a web server on the instance, and `POST /v1/instances/{id}/public-ports` gives it a public HTTPS URL, serving the test dealer sites.
- **Crons:** "Audit nightly" calls `POST /v1/instances/{id}/crons` (`0 2 * * *`, America/Los_Angeles). The platform wakes the agent every night even if its computer is asleep.

**Monid** prices the collateral:
- **Discover:** `POST /v1/discover` picks a listing-extraction endpoint at runtime (`mrscraper/scrape/listing`), with its price shown in the dashboard.
- **Run:** `POST /v1/run` scraped marketplace search results for the financed models into structured listings (title, price, year, hours).
- **Valuation:** the median comp becomes the unit's market value, which drives collateral coverage, loan-to-value per unit and the recovery value on each sold-out-of-trust exception. For example: 39 live listings for the Bobcat T66, for about $0.03 in total.

**InstaCloud** hosts the app:
- **Compute:** an always-on service built from our Dockerfile.
- **Postgres:** a managed database bound in as `DATABASE_URL`. Every audit run and finding is written to `audit_runs` and `audit_findings`, which back the History tab.

_The dealers, lender and serial numbers are fictional test data. The agent runs, the browsing and the Monid scrapes are real._
