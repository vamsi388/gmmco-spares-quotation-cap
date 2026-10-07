const cds = require('@sap/cds');

module.exports = class JobService extends cds.ApplicationService {
  async init() {
    const db = cds.entities('gmmco.quotation');
    const log = (jobName, status, message) =>
      INSERT.into(db.JobLog).entries({ jobName, startedAt: new Date().toISOString(), status, message });

    // Daily: Approved / Issued quotations past their validity -> Expired
    this.on('expireQuotations', async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const n = await UPDATE(db.Quotations)
          .set({ status: 'Expired' })
          .where({ status: { in: ['Approved', 'Issued'] }, validTo: { '<': today } });
        const msg = `${n} quotation(s) expired`;
        await log('expireQuotations', 'SUCCESS', msg);
        return msg;
      } catch (e) {
        await log('expireQuotations', 'FAILED', e.message);
        throw e;                       // TODO: Alert Notification to technical admin
      }
    });

    // Remind approvers of quotations pending for more than 24 hours
    this.on('sendReminders', async () => {
      try {
        const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const pending = await SELECT.from(db.Quotations)
          .columns('ID', 'quotationNo', 'status')
          .where({ status: { in: ['PendingL1', 'PendingL2'] }, modifiedAt: { '<': cutoff } });
        // TODO: call SAP Alert Notification for each pending quotation
        const msg = `${pending.length} reminder(s) to send`;
        await log('sendReminders', 'SUCCESS', msg);
        return msg;
      } catch (e) {
        await log('sendReminders', 'FAILED', e.message);
        throw e;
      }
    });

    // Poll S/4HANA for PR release, PO, supplier confirmation and goods receipt
    this.on('syncProcurement', async () => {
      try {
        const open = await SELECT.from(db.QuotationItems)
          .columns('ID', 'material', 'prNumber', 'poNumber', 'procurementStatus')
          .where({ procurementStatus: { in: ['PRCreated', 'PRReleased', 'POCreated', 'SupplierConfirmed', 'Shipped'] } });
        // TODO: read PR / PO / material document from S/4HANA and call updateProcurement
        const msg = `${open.length} open procurement item(s) checked`;
        await log('syncProcurement', 'SUCCESS', msg);
        return msg;
      } catch (e) {
        await log('syncProcurement', 'FAILED', e.message);
        throw e;
      }
    });

    return super.init();
  }
};