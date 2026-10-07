const cds = require('@sap/cds');
const LOG = cds.log('quotation');

const GST_PCT = 18;                                   // ASSUMPTION - confirm with Finance
const PLANT   = process.env.GMMCO_PLANT || '1000';    // ASSUMPTION - supplying plant
const EDITABLE  = ['Draft', 'Returned', 'AwaitingStock'];
const PROC_FLOW = ['None', 'PRCreated', 'PRReleased', 'POCreated', 'SupplierConfirmed', 'Shipped', 'GRPosted'];

const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const today  = () => new Date().toISOString().slice(0, 10);
const keyOf  = p => (p && typeof p === 'object' ? p.ID : p);

module.exports = class QuotationService extends cds.ApplicationService {
  async init() {
    const { Quotations, QuotationItems } = this.entities;
    const db = cds.entities('gmmco.quotation');

    // ===================== helpers =====================
    const audit = (entity, key, field, oldValue, newValue, user) =>
      INSERT.into(db.AuditLog).entries({
        entity, entityKey: String(key), field,
        oldValue: oldValue == null ? null : String(oldValue),
        newValue: newValue == null ? null : String(newValue),
        changedBy: user, changedAt: new Date().toISOString()
      });

    const addHistory = (quotationId, level, user, action, comments) =>
      INSERT.into(db.ApprovalHistory).entries({
        quotation_ID: quotationId, level, approver: user, action,
        comments: comments || null, timestamp: new Date().toISOString()
      });

    const logProc = (itemId, event, refDoc, user) =>
      INSERT.into(db.ProcurementEvents).entries({
        item_ID: itemId, event, refDoc: refDoc || null,
        changedBy: user, changedAt: new Date().toISOString()
      });

    const setStatus = async (q, status, user, extra = {}) => {
      await UPDATE(db.Quotations, q.ID).with({ status, ...extra });
      await audit('Quotations', q.ID, 'status', q.status, status, user);
    };

    const getQuotation = async id => {
      const q = await SELECT.one.from(db.Quotations).where({ ID: id });
      if (!q) return null;
      q.items = await SELECT.from(db.QuotationItems).where({ quotation_ID: id }).orderBy('itemNo');
      return q;
    };

    // Stock check (mock table now; S/4HANA material stock API later)
    const checkStock = async item => {
      if (item.procurementStatus === 'GRPosted') {
        item.stockStatus = 'InStock';
        item.availableQty = item.quantity;
        return;
      }
      const s = await SELECT.one.from(db.MaterialStock).where({ material: item.material, plant: PLANT });
      const avail = Number(s?.availableQty || 0);
      const qty = Number(item.quantity || 0);
      item.availableQty = avail;
      item.stockStatus = avail >= qty ? 'InStock' : avail > 0 ? 'Partial' : 'NotInStock';
    };

    // Pricing rule lookup: material-specific rule first, then material-group rule
    const findConfig = async (material, onDate) => {
      const base = { status: 'Active', validFrom: { '<=': onDate }, validTo: { '>=': onDate } };
      let cfg = await SELECT.one.from(db.PricingConfigs).where({ ...base, material });
      if (cfg) return cfg;
      const mat = await SELECT.one.from(db.Materials).where({ material });
      if (mat?.materialGroup)
        cfg = await SELECT.one.from(db.PricingConfigs)
          .where({ ...base, materialGroup: mat.materialGroup }).and('material is null');
      return cfg;
    };

    // Net = Base x (1 + Margin%) x (1 - Discount%). Returns approval level needed: 0 / 1 / 2
    const priceItem = async (item, onDate, errors) => {
      const cfg = await findConfig(item.material, onDate);
      if (!cfg) { errors.push(`No active pricing rule for material ${item.material}`); return 0; }

      if (!item.description || !item.uom) {
        const mat = await SELECT.one.from(db.Materials).where({ material: item.material });
        if (mat) { item.description = item.description || mat.description; item.uom = item.uom || mat.uom; }
      }
      const qty  = Number(item.quantity || 0);
      const disc = Number(item.discountPct || 0);
      if (qty <= 0) errors.push(`Item ${item.material}: quantity must be greater than 0`);
      if (disc < 0 || disc > Number(cfg.maxDiscountPct || 0))
        errors.push(`Item ${item.material}: discount ${disc}% exceeds the maximum allowed ${cfg.maxDiscountPct}%`);

      const listPrice = Number(cfg.basePrice) * (1 + Number(cfg.marginPct || 0) / 100);
      item.basePrice = round2(cfg.basePrice);
      item.marginPct = Number(cfg.marginPct || 0);
      item.netPrice  = round2(listPrice * (1 - disc / 100));
      item.lineTotal = round2(item.netPrice * qty + Number(item.deliveryCost || 0));

      const min = Number(cfg.minPriceThreshold || 0);
      if (min > 0 && item.netPrice < min) {
        item.thresholdBreached = true;
        item.deviationPct = round2(((min - item.netPrice) / min) * 100);
        const l1 = Number(cfg.approvalL1Limit || 0), l2 = Number(cfg.approvalL2Limit || 0);
        if (item.deviationPct <= l1) return 1;
        if (item.deviationPct <= l2) return 2;
        errors.push(`Item ${item.material}: price deviation ${item.deviationPct}% exceeds the maximum approvable limit ${l2}%`);
        return 2;
      }
      item.thresholdBreached = false;
      item.deviationPct = 0;
      return 0;
    };

    const compute = async (q, errors) => {
      const onDate = today();
      let level = 0, net = 0, n = 0;
      for (const it of q.items || []) {
        if (!it.itemNo) it.itemNo = (++n) * 10; else n = Math.max(n, it.itemNo / 10);
        await checkStock(it);
        level = Math.max(level, await priceItem(it, onDate, errors));
        net += Number(it.lineTotal || 0);
      }
      q.netValue = round2(net);
      q.taxValue = round2(net * GST_PCT / 100);
      q.totalValue = round2(q.netValue + q.taxValue);
      q.approvalLevelRequired = level;
      return q;
    };

    const reprice = async id => {
      const q = await getQuotation(id);
      const errors = [];
      await compute(q, errors);
      for (const it of q.items) {
        await UPDATE(db.QuotationItems, it.ID).with({
          description: it.description, uom: it.uom, itemNo: it.itemNo,
          stockStatus: it.stockStatus, availableQty: it.availableQty,
          basePrice: it.basePrice, marginPct: it.marginPct, netPrice: it.netPrice,
          lineTotal: it.lineTotal, thresholdBreached: it.thresholdBreached, deviationPct: it.deviationPct
        });
      }
      await UPDATE(db.Quotations, id).with({
        netValue: q.netValue, taxValue: q.taxValue, totalValue: q.totalValue,
        approvalLevelRequired: q.approvalLevelRequired
      });
      return { q, errors };
    };

    // When every item is in stock (e.g. after GR) the quotation returns to Draft
    const releaseIfReady = async (quotationId, user) => {
      const q = await getQuotation(quotationId);
      if (q?.status === 'AwaitingStock' && q.items.every(i => i.stockStatus === 'InStock')) {
        await reprice(quotationId);
        await setStatus(q, 'Draft', user);
      }
    };

    const validateHeader = (q, req) => {
      if (!q.customerId) req.error(400, 'Customer is mandatory', 'in/customerId');
      if (!q.validFrom)  req.error(400, 'Valid From is mandatory', 'in/validFrom');
      if (!q.validTo)    req.error(400, 'Valid To is mandatory', 'in/validTo');
      if (q.validFrom && q.validTo && q.validTo < q.validFrom)
        req.error(400, 'Valid To cannot be earlier than Valid From', 'in/validTo');
    };

    const loadFor = async (req, allowed) => {
      const q = await getQuotation(keyOf(req.params[0]));
      if (!q) return req.reject(404, 'Quotation not found');
      if (allowed && !allowed.includes(q.status))
        return req.reject(409, `Action not allowed when status is ${q.status}`);
      return q;
    };

    // ===================== create / update / delete =====================
    this.before('CREATE', Quotations, async req => {
      const q = req.data;
      validateHeader(q, req);
      if (q.customerId && !q.customerName) {
        const bp = await SELECT.one.from(db.BusinessPartners).where({ bpId: q.customerId });
        if (!bp) req.error(400, `Customer ${q.customerId} not found`, 'in/customerId');
        else q.customerName = bp.name;
      }
    });

    // number, stock check and pricing are set right after the insert (works for deep inserts too)
    this.after('CREATE', Quotations, async (data, req) => {
      const { c } = await SELECT.one.from(db.Quotations).columns('count(*) as c');
      const quotationNo = `Q-${new Date().getFullYear()}-${String(Number(c)).padStart(5, '0')}`;
      await UPDATE(db.Quotations, data.ID).with({ quotationNo });
      const { errors } = await reprice(data.ID);
      if (errors.length) req.reject(400, errors.join('; '));
    });

    this.before(['UPDATE', 'DELETE'], Quotations, async req => {
      const id = req.data.ID || keyOf(req.params?.[0]);
      const q = await SELECT.one.from(db.Quotations).columns('status').where({ ID: id });
      if (q && !EDITABLE.includes(q.status))
        req.reject(409, `Quotation cannot be changed when status is ${q.status}`);
      if (req.event === 'UPDATE') {
        const cur = await SELECT.one.from(db.Quotations).where({ ID: id });
        validateHeader({ ...cur, ...req.data }, req);
      }
    });

    this.before(['CREATE', 'UPDATE', 'DELETE'], QuotationItems, async req => {
      let parentId = req.data.quotation_ID;
      if (!parentId) {
        const itemId = req.data.ID || keyOf(req.params?.at(-1));
        const it = itemId && await SELECT.one.from(db.QuotationItems).columns('quotation_ID').where({ ID: itemId });
        parentId = it?.quotation_ID;
      }
      req._parentId = parentId;
      const parent = parentId && await SELECT.one.from(db.Quotations).columns('status').where({ ID: parentId });
      if (!parent) return req.reject(400, 'Item must belong to a quotation');
      if (!EDITABLE.includes(parent.status))
        return req.reject(409, `Items cannot be changed when quotation status is ${parent.status}`);
      if (req.event === 'CREATE' && !req.data.itemNo) {
        const { m } = await SELECT.one.from(db.QuotationItems).columns('max(itemNo) as m').where({ quotation_ID: parentId });
        req.data.itemNo = (Number(m) || 0) + 10;
      }
    });

    this.after(['CREATE', 'UPDATE', 'DELETE'], QuotationItems, async (_data, req) => {
      if (!req._parentId) return;
      const { errors } = await reprice(req._parentId);
      if (errors.length) return req.reject(400, errors.join('; '));
      await releaseIfReady(req._parentId, req.user.id);
    });

    // ===================== stock and procurement =====================
    this.on('createPurchaseRequisition', QuotationItems, async req => {
      const id = keyOf(req.params.at(-1));
      const it = await SELECT.one.from(db.QuotationItems).where({ ID: id });
      if (!it) return req.reject(404, 'Item not found');
      await checkStock(it);
      if (it.stockStatus === 'InStock') return req.reject(409, 'Stock is available, no purchase requisition needed');
      if (it.procurementStatus !== 'None') return req.reject(409, `Procurement already started (${it.procurementStatus})`);

      // TODO: call S/4HANA Purchase Requisition API through the Destination Service
      const prNo = 'PR' + String(Date.now()).slice(-8);
      await UPDATE(db.QuotationItems, id).with({ procurementStatus: 'PRCreated', prNumber: prNo, stockStatus: it.stockStatus });
      await logProc(id, 'PRCreated', prNo, req.user.id);

      const q = await SELECT.one.from(db.Quotations).where({ ID: it.quotation_ID });
      if (['Draft', 'Returned'].includes(q.status)) await setStatus(q, 'AwaitingStock', req.user.id);
      return this.read(QuotationItems, id);
    });

    this.on('updateProcurement', QuotationItems, async req => {
      const id = keyOf(req.params.at(-1));
      const { status, refDoc, expectedDate } = req.data;
      const it = await SELECT.one.from(db.QuotationItems).where({ ID: id });
      if (!it) return req.reject(404, 'Item not found');

      const from = PROC_FLOW.indexOf(it.procurementStatus), to = PROC_FLOW.indexOf(status);
      if (to < 0) return req.reject(400, `Unknown status ${status}`);
      if (from === 0) return req.reject(409, 'Create the purchase requisition first');
      if (to <= from) return req.reject(409, `Cannot move from ${it.procurementStatus} to ${status}`);
      if (status === 'SupplierConfirmed' && !expectedDate && !it.expectedDate)
        return req.reject(400, 'Supplier confirmed delivery date is mandatory');

      const upd = { procurementStatus: status };
      if (status === 'POCreated' && refDoc) upd.poNumber = refDoc;
      if (expectedDate) upd.expectedDate = expectedDate;
      if (status === 'GRPosted') { upd.stockStatus = 'InStock'; upd.availableQty = it.quantity; }

      await UPDATE(db.QuotationItems, id).with(upd);
      await logProc(id, status, refDoc, req.user.id);
      await audit('QuotationItems', id, 'procurementStatus', it.procurementStatus, status, req.user.id);
      // TODO: Alert Notification to the Sales Executive (supplier date / goods receipt)
      if (status === 'GRPosted') await releaseIfReady(it.quotation_ID, req.user.id);
      return this.read(QuotationItems, id);
    });

    // ===================== quotation actions =====================
    this.on('recalculate', Quotations, async req => {
      const q = await loadFor(req, EDITABLE);
      const { errors } = await reprice(q.ID);
      if (errors.length) return req.reject(400, errors.join('; '));
      return this.read(Quotations, q.ID);
    });

    this.on('submit', Quotations, async req => {
      const q = await loadFor(req, ['Draft', 'Returned']);
      const missing = [];
      if (!q.customerId) missing.push('Customer is mandatory');
      if (!q.validFrom || !q.validTo) missing.push('Valid From and Valid To are mandatory');
      if (q.validFrom && q.validTo && q.validTo < q.validFrom) missing.push('Valid To cannot be earlier than Valid From');
      if (!q.items.length) missing.push('Add at least one item before submitting');
      if (missing.length) return req.reject(400, missing.join('; '));

      const { q: priced, errors } = await reprice(q.ID);
      if (errors.length) return req.reject(400, errors.join('; '));

      const noStock = priced.items.filter(i => i.stockStatus !== 'InStock');
      if (noStock.length)
        return req.reject(409, `Stock not available for: ${noStock.map(i => i.material).join(', ')}. ` +
                               'Raise a purchase requisition or wait for the goods receipt.');

      if (priced.approvalLevelRequired === 0) {
        await setStatus(q, 'Approved', req.user.id);
        await addHistory(q.ID, 0, 'system', 'AutoApproved', 'All prices within thresholds');
      } else {
        await setStatus(q, 'PendingL1', req.user.id);
        await addHistory(q.ID, 0, req.user.id, 'Submitted', null);
        // TODO: SAP Alert Notification -> approver
      }
      return this.read(Quotations, q.ID);
    });

    const decide = decision => async req => {
      const q = await loadFor(req, ['PendingL1', 'PendingL2']);
      const level = q.status === 'PendingL1' ? 1 : 2;
      const role  = level === 1 ? 'SalesManager' : 'RegionalHead';
      if (!req.user.is(role)) return req.reject(403, `Only ${role} can act on a quotation in status ${q.status}`);
      if (q.createdBy === req.user.id) return req.reject(403, 'You cannot approve your own quotation');
      const comments = req.data.comments;
      if (decision !== 'Approved' && !comments?.trim())
        return req.reject(400, 'A comment is mandatory for reject / return');

      if (decision === 'Approved') {
        const next = (level === 1 && q.approvalLevelRequired === 2) ? 'PendingL2' : 'Approved';
        await setStatus(q, next, req.user.id);
      } else {
        await setStatus(q, decision === 'Rejected' ? 'Rejected' : 'Returned', req.user.id);
      }
      await addHistory(q.ID, level, req.user.id, decision, comments);
      // TODO: Alert Notification -> Sales Executive / next approver
      return this.read(Quotations, q.ID);
    };
    this.on('approve', Quotations, decide('Approved'));
    this.on('reject', Quotations, decide('Rejected'));
    this.on('returnForRevision', Quotations, decide('Returned'));

    this.on('issue', Quotations, async req => {
      const q = await loadFor(req, ['Approved']);
      await setStatus(q, 'Issued', req.user.id);
      return this.read(Quotations, q.ID);
    });

    this.on('createSalesOrder', Quotations, async req => {
      const q = await loadFor(req, ['Approved', 'Issued']);
      if (q.s4SalesOrderNo) return req.reject(409, `Sales Order ${q.s4SalesOrderNo} already exists`);
      if (cds.env.requires?.API_SALES_ORDER_SRV)
        return req.reject(501, 'S/4HANA Sales Order call not implemented yet');
      const soNo = String(Date.now()).slice(-10);          // mock number
      LOG.warn('Mock sales order created:', soNo);
      await setStatus(q, 'Converted', req.user.id, { s4SalesOrderNo: soNo });
      return this.read(Quotations, q.ID);
    });

    this.on('cancel', Quotations, async req => {
      const q = await loadFor(req, ['Draft', 'Returned', 'AwaitingStock', 'PendingL1', 'PendingL2']);
      await setStatus(q, 'Cancelled', req.user.id);
      return this.read(Quotations, q.ID);
    });

    this.on('myApprovals', async req => {
      const statuses = [];
      if (req.user.is('SalesManager')) statuses.push('PendingL1');
      if (req.user.is('RegionalHead')) statuses.push('PendingL2');
      if (!statuses.length) return [];
      return SELECT.from(db.Quotations).where({ status: { in: statuses }, createdBy: { '!=': req.user.id } });
    });

    return super.init();
  }
};