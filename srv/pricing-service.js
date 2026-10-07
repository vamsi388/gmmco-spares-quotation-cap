const cds = require('@sap/cds');
const keyOf = p => (p && typeof p === 'object' ? p.ID : p);

module.exports = class PricingService extends cds.ApplicationService {
  async init() {
    const { PricingConfigs } = this.entities;
    const db = cds.entities('gmmco.quotation');

    const audit = (key, field, oldValue, newValue, user) =>
      INSERT.into(db.AuditLog).entries({
        entity: 'PricingConfigs', entityKey: String(key), field,
        oldValue: oldValue == null ? null : String(oldValue),
        newValue: newValue == null ? null : String(newValue),
        changedBy: user, changedAt: new Date().toISOString()
      });

    // FS-01 validations
    const validate = (d, req) => {
      if (d.basePrice != null && !(Number(d.basePrice) > 0))
        req.error(400, 'Base price must be greater than 0', 'in/basePrice');
      for (const f of ['marginPct', 'maxDiscountPct']) {
        if (d[f] != null && (Number(d[f]) < 0 || Number(d[f]) > 100))
          req.error(400, `${f} must be between 0 and 100`, `in/${f}`);
      }
      if (d.validFrom && d.validTo && d.validTo < d.validFrom)
        req.error(400, 'Valid To cannot be earlier than Valid From', 'in/validTo');
      if (d.approvalL1Limit != null && d.approvalL2Limit != null &&
          Number(d.approvalL2Limit) < Number(d.approvalL1Limit))
        req.error(400, 'Approval Level 2 limit cannot be lower than Level 1 limit', 'in/approvalL2Limit');
    };

    this.before('CREATE', PricingConfigs, req => {
      if (!req.data.material && !req.data.materialGroup)
        req.error(400, 'Enter a Material or a Material Group', 'in/material');
      validate(req.data, req);
    });

    this.before('UPDATE', PricingConfigs, async req => {
      const old = await SELECT.one.from(db.PricingConfigs).where({ ID: req.data.ID });
      req._old = old;
      validate({ ...old, ...req.data }, req);
    });

    this.after('UPDATE', PricingConfigs, async (_d, req) => {
      if (req.data.basePrice != null && req._old)
        await audit(req.data.ID, 'basePrice', req._old.basePrice, req.data.basePrice, req.user.id);
    });

    // Activate only if no other active rule overlaps for the same material / group
    this.on('activate', PricingConfigs, async req => {
      const id = keyOf(req.params[0]);
      const cfg = await SELECT.one.from(db.PricingConfigs).where({ ID: id });
      if (!cfg) return req.reject(404, 'Pricing rule not found');

      const where = { status: 'Active', ID: { '!=': id }, category: cfg.category,
                      validFrom: { '<=': cfg.validTo }, validTo: { '>=': cfg.validFrom } };
      let q;
      if (cfg.material) q = SELECT.one.from(db.PricingConfigs).where({ ...where, material: cfg.material });
      else q = SELECT.one.from(db.PricingConfigs).where({ ...where, materialGroup: cfg.materialGroup }).and('material is null');
      if (await q) return req.reject(409, 'An active pricing rule already exists for this material / group in the same validity period');

      await UPDATE(db.PricingConfigs, id).with({ status: 'Active' });
      await audit(id, 'status', cfg.status, 'Active', req.user.id);
      return this.read(PricingConfigs, id);
    });

    this.on('deactivate', PricingConfigs, async req => {
      const id = keyOf(req.params[0]);
      const cfg = await SELECT.one.from(db.PricingConfigs).where({ ID: id });
      if (!cfg) return req.reject(404, 'Pricing rule not found');
      await UPDATE(db.PricingConfigs, id).with({ status: 'Inactive' });
      await audit(id, 'status', cfg.status, 'Inactive', req.user.id);
      return this.read(PricingConfigs, id);
    });

    return super.init();
  }
};