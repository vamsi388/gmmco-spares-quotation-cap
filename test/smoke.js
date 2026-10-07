// Run: start the server with `npx cds watch` in one terminal, then `node test/smoke.js` in another.
const BASE = process.env.BASE_URL || 'http://localhost:4004';
const Q = '/odata/v4/quotation';
const auth = u => 'Basic ' + Buffer.from(`${u}:secret`).toString('base64');
const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
let pass = 0, fail = 0;

async function call(user, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers.Authorization = auth(user);
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra); }
}
const getQ  = async id => (await call('sales', 'GET', `${Q}/Quotations(${id})?$expand=items`)).data;
const act   = (user, id, name, body = {}) => call(user, 'POST', `${Q}/Quotations(${id})/QuotationService.${name}`, body);
const iact  = (user, id, name, body = {}) => call(user, 'POST', `${Q}/QuotationItems(${id})/QuotationService.${name}`, body);
const create = items => call('sales', 'POST', `${Q}/Quotations`,
  { customerId: '1000002', validFrom: day(0), validTo: day(60), currency_code: 'INR', items });
const err = r => JSON.stringify(r.data?.error?.message || r.data);

(async () => {
  let r, q;

  // ---- security basics
  r = await call(null, 'GET', `${Q}/Quotations`);
  check('No login -> 401', r.status === 401, r.status);
  r = await call('scheduler', 'GET', `${Q}/Quotations`);
  check('Job user cannot read quotations -> 403', r.status === 403, r.status);

  // ---- pricing rules
  r = await call('pricing', 'GET', '/odata/v4/pricing/PricingConfigs');
check('Pricing rules readable (sample rules loaded)', r.status === 200 && r.data.value.length >= 4, r.status);  r = await call('pricing', 'POST', '/odata/v4/pricing/PricingConfigs',
    { category: 'Part', material: 'X1', basePrice: 100, marginPct: 10, maxDiscountPct: 150, validFrom: day(0), validTo: day(30) });
  check('Invalid pricing rule (discount > 100) rejected', r.status === 400, r.status + ' ' + err(r));
  r = await call('sales', 'POST', '/odata/v4/pricing/PricingConfigs',
    { category: 'Part', material: 'X1', basePrice: 100, validFrom: day(0), validTo: day(30) });
  check('Sales Executive cannot create pricing rule -> 403', r.status === 403, r.status);

  // ---- flow A: within threshold -> auto approved -> issue -> sales order
  r = await create([{ material: 'CAT-1R0719', quantity: 10, discountPct: 2 }]);
  check('A1 create quotation -> 201', r.status === 201, r.status + ' ' + err(r));
  const A = r.data.ID; q = await getQ(A);
  check('A2 status Draft and number generated', q.status === 'Draft' && /^Q-\d{4}-\d{5}$/.test(q.quotationNo || ''), q.status + ' ' + q.quotationNo);
  check('A3 net value 28175', Number(q.netValue) === 28175, q.netValue);
  check('A4 tax 18% and total', Number(q.taxValue) === 5071.5 && Number(q.totalValue) === 33246.5, `${q.taxValue}/${q.totalValue}`);
  check('A5 item InStock', q.items?.[0]?.stockStatus === 'InStock', q.items?.[0]?.stockStatus);
  r = await act('sales', A, 'submit'); q = await getQ(A);
  check('A6 within threshold -> auto Approved', r.status === 200 && q.status === 'Approved', r.status + ' ' + q.status + ' ' + err(r));
  r = await act('sales', A, 'issue'); q = await getQ(A);
  check('A7 issue -> Issued', q.status === 'Issued', q.status);
  r = await act('sales', A, 'createSalesOrder'); q = await getQ(A);
  check('A8 sales order -> Converted with number', q.status === 'Converted' && !!q.s4SalesOrderNo, q.status);
  r = await act('sales', A, 'createSalesOrder');
  check('A9 second sales order blocked -> 409', r.status === 409, r.status);
  r = await call('sales', 'PATCH', `${Q}/Quotations(${A})`, { remarks: 'late change' });
  check('A10 converted quotation cannot be edited -> 409', r.status === 409, r.status);

  // ---- flow B: Level 1 approval
  r = await create([{ material: 'CAT-1R0719', quantity: 4, discountPct: 10 }]);
  const B = r.data.ID; q = await getQ(B);
  check('B1 item flagged as threshold breach (dev 0.48%)', q.items[0].thresholdBreached === true && Number(q.items[0].deviationPct) === 0.48, JSON.stringify(q.items[0]));
  r = await act('sales', B, 'submit'); q = await getQ(B);
  check('B2 submit -> PendingL1', q.status === 'PendingL1', q.status + ' ' + err(r));
  r = await act('sales', B, 'approve', { comments: 'x' });
  check('B3 Sales Executive cannot approve -> 403', r.status === 403, r.status);
  r = await act('manager', B, 'reject', { comments: '' });
  check('B4 reject without comment -> 400', r.status === 400, r.status);
  r = await act('manager', B, 'approve', { comments: 'OK' }); q = await getQ(B);
  check('B5 manager approves -> Approved', q.status === 'Approved', q.status + ' ' + err(r));

  // ---- flow C: Level 2 approval
  r = await create([{ material: 'CAT-9X3263', quantity: 1, discountPct: 10 }]);
  const C = r.data.ID; q = await getQ(C);
  check('C1 level 2 required (dev 5.71%)', Number(q.approvalLevelRequired) === 2, q.approvalLevelRequired);
  await act('sales', C, 'submit');
  await act('manager', C, 'approve', { comments: 'L1 ok' }); q = await getQ(C);
  check('C2 after L1 -> PendingL2', q.status === 'PendingL2', q.status);
  r = await act('manager', C, 'approve', { comments: 'again' });
  check('C3 manager cannot do L2 -> 403', r.status === 403, r.status);
  await act('head', C, 'approve', { comments: 'L2 ok' }); q = await getQ(C);
  check('C4 regional head approves -> Approved', q.status === 'Approved', q.status);
  r = await call('sales', 'GET', `${Q}/ApprovalHistory?$filter=quotation_ID eq ${C}`);
  check('C5 approval history has 3 entries', r.data.value?.length === 3, r.data.value?.length);

  // ---- flow D: return, correct, resubmit
  r = await create([{ material: 'CAT-1R0719', quantity: 4, discountPct: 10 }]);
  const D = r.data.ID; await act('sales', D, 'submit');
  r = await act('manager', D, 'returnForRevision', { comments: 'Reduce discount' }); q = await getQ(D);
  check('D1 returned -> Returned', q.status === 'Returned', q.status + ' ' + err(r));
  r = await call('sales', 'PATCH', `${Q}/QuotationItems(${q.items[0].ID})`, { discountPct: 2 });
  check('D2 edit item while Returned -> ok', r.status === 200, r.status + ' ' + err(r));
  q = await getQ(D);
  check('D3 price recalculated (2817.5)', Number(q.items[0].netPrice) === 2817.5, q.items[0].netPrice);
  r = await act('sales', D, 'submit'); q = await getQ(D);
  check('D4 resubmit -> auto Approved', q.status === 'Approved', q.status);

  // ---- flow E: stock missing -> PR -> PO -> GR -> submit
  r = await create([{ material: 'CAT-3E2247', quantity: 4, discountPct: 5 }]);
  const E = r.data.ID; q = await getQ(E); const itemE = q.items[0].ID;
  check('E1 item NotInStock', q.items[0].stockStatus === 'NotInStock', q.items[0].stockStatus);
  r = await act('sales', E, 'submit');
  check('E2 submit blocked without stock -> 409', r.status === 409, r.status + ' ' + err(r));
  r = await iact('sales', itemE, 'createPurchaseRequisition'); q = await getQ(E);
  check('E3 PR created -> quotation AwaitingStock', r.status === 200 && q.status === 'AwaitingStock', q.status + ' ' + err(r));
  r = await iact('sales', itemE, 'updateProcurement', { status: 'PRReleased' });
  check('E4 Sales Executive cannot update procurement -> 403', r.status === 403, r.status);
  await iact('supply', itemE, 'updateProcurement', { status: 'PRReleased' });
  await iact('supply', itemE, 'updateProcurement', { status: 'POCreated', refDoc: '4500001234' });
  r = await iact('supply', itemE, 'updateProcurement', { status: 'SupplierConfirmed' });
  check('E5 supplier confirmation without date -> 400', r.status === 400, r.status);
  await iact('supply', itemE, 'updateProcurement', { status: 'SupplierConfirmed', expectedDate: day(7) });
  await iact('supply', itemE, 'updateProcurement', { status: 'Shipped' });
  r = await iact('supply', itemE, 'updateProcurement', { status: 'GRPosted' }); q = await getQ(E);
  check('E6 goods receipt -> item InStock, quotation Draft', q.items[0].stockStatus === 'InStock' && q.status === 'Draft', q.status + ' ' + q.items[0].stockStatus + ' ' + err(r));
  r = await call('sales', 'GET', `${Q}/ProcurementEvents?$filter=item_ID eq ${itemE}`);
  check('E7 six procurement events logged', r.data.value?.length === 6, r.data.value?.length);
  r = await act('sales', E, 'submit'); q = await getQ(E);
  check('E8 submit after GR -> Approved', q.status === 'Approved', q.status + ' ' + err(r));

  // ---- cancel
  r = await create([{ material: 'CAT-1R0719', quantity: 1 }]);
  const F = r.data.ID; await act('sales', F, 'cancel'); q = await getQ(F);
  check('F1 cancel -> Cancelled', q.status === 'Cancelled', q.status);

  // ---- master data and jobs
  r = await call('sales', 'GET', "/odata/v4/masterdata/BusinessPartners?$filter=contains(name,'Coastal')");
  check('G1 customer value help works', r.status === 200 && r.data.value.length === 1, r.status);
  r = await call('scheduler', 'POST', '/odata/v4/job/expireQuotations', {});
  check('G2 expire job runs', r.status === 200 && /expired/.test(r.data?.value || ''), r.status + ' ' + JSON.stringify(r.data));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });