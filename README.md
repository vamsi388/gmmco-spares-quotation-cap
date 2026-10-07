# GMMCO Spares Quotation - CAP Backend

SAP BTP CAP (Node.js) backend for GMMCO's spare-parts quotation process.
A Sales Executive (SE) builds a quotation; the system checks stock in S/4HANA, tracks procurement
(PR -> PO -> GR) for missing parts, applies pricing rules, routes the quotation for approval when
price thresholds are breached, and finally converts it to a Sales Order.

## Business flow
1. SE adds a part to the quotation; the system checks stock in S/4HANA.
2. **Stock available** -> skip procurement. **Stock missing** ->
   PR created -> PR released -> buyer picks supplier -> PO created -> supplier confirms date ->
   supplier ships -> Goods Receipt (stock goes up in S/4HANA).
3. Pricing applied (base price, margin, discount rules).
4. Validation (UI5 client checks, then CAP server checks).
5. Price within threshold -> **auto-approved**. Otherwise the approver is alerted and
   approves, rejects or returns it (SE corrects and resubmits).
6. SE shares the quotation (PDF by email); status **Issued**.
7. Customer accepts -> SE converts to Sales Order (Sales Order API). Otherwise the quotation
   expires through a Job Scheduler batch job.
8. Fulfilment (delivery, invoice, payment) continues in S/4HANA.

## Quotation status model
`Draft -> AwaitingStock -> Draft -> PendingL1 -> (PendingL2) -> Approved -> Issued -> Converted`
Other states: `Returned`, `Rejected`, `Expired`, `Cancelled`. Auto-approved quotations go straight to `Approved`.

## Item procurement status
`None -> PRCreated -> PRReleased -> POCreated -> SupplierConfirmed -> Shipped -> GRPosted`

## Tech stack
SAP CAP (Node.js), OData V4, SAP HANA Cloud (SQLite locally), XSUAA, SAP Cloud Foundry,
Destination Service + Cloud Connector to S/4HANA On-Premise, Job Scheduler, Alert Notification.

## Services (`/odata/v4/...`)
| Service | Purpose |
|---|---|
| `pricing` | Pricing rules: CRUD, validations, activate / deactivate |
| `quotation` | Quotations and items, stock check, procurement tracking, pricing, approval, sales order |
| `masterdata` | Business Partner and Material value helps (mock now, S/4HANA later) |
| `job` | `expireQuotations`, `sendReminders`, `syncProcurement` (called by Job Scheduler) |

## Roles
`PricingAdmin`, `SalesExecutive`, `SalesManager`, `RegionalHead`, `SupplyChain`, `Auditor`, `JobScheduler`

## Run locally
```bash
npm install
npx cds watch
```
Mock users (password `secret`): `pricing`, `sales`, `manager`, `head`, `supply`, `auditor`, `scheduler`.
Sample requests: `test/quotation.http`.

## Project structure
```
db/schema.cds              data model
db/data/*.csv              sample data (partners, materials, stock, pricing rules)
srv/pricing-service.*      pricing configuration
srv/quotation-service.*    quotation, stock, procurement, approval logic
srv/masterdata-service.*   master data proxy
srv/job-service.*          scheduled jobs
test/quotation.http        test requests
```

## Integration status
| Area | Status |
|---|---|
| Stock check | Local mock table `MaterialStock`; replace with S/4HANA material stock API |
| PR / PO / GR | Local mock numbers; real calls via S/4HANA APIs through Destination Service (TODO) |
| Sales Order | Mock number; Sales Order API call (TODO) |
| Alert Notification | TODO |
| PDF output / email | TODO |

## Assumptions to confirm with the business
- Tax 18% GST, plant `1000` (set `GMMCO_PLANT`).
- Approval levels L1 / L2 and deviation limits.
- Who creates PR/PO: the SE, the supply-chain team, or automatically.

## Roadmap
1. Backend (this repo)  2. UI5/Fiori apps (Pricing Configuration, Quotation Management, Approvals)
3. S/4HANA integration  4. `xs-security.json`, `mta.yaml`, deployment to Cloud Foundry
