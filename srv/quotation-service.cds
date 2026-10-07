using gmmco.quotation as db from '../db/schema';

@path: '/odata/v4/quotation'
@requires: 'authenticated-user'
service QuotationService {

  @restrict: [
    { grant: 'READ', to: ['SalesExecutive', 'SalesManager', 'RegionalHead', 'SupplyChain', 'Auditor'] },
    { grant: ['CREATE', 'UPDATE', 'DELETE', 'recalculate', 'submit', 'issue', 'createSalesOrder', 'cancel'],
      to: 'SalesExecutive' },
    { grant: ['approve', 'reject', 'returnForRevision'], to: ['SalesManager', 'RegionalHead'] }
  ]
  entity Quotations as projection on db.Quotations actions {
    action recalculate()                             returns Quotations;
    action submit()                                  returns Quotations;
    action approve(comments : String(500))           returns Quotations;
    action reject(comments : String(500))            returns Quotations;
    action returnForRevision(comments : String(500)) returns Quotations;
    action issue()                                   returns Quotations;
    action createSalesOrder()                        returns Quotations;
    action cancel()                                  returns Quotations;
  };

  @restrict: [
    { grant: 'READ', to: ['SalesExecutive', 'SalesManager', 'RegionalHead', 'SupplyChain', 'Auditor'] },
    { grant: ['CREATE', 'UPDATE', 'DELETE'], to: 'SalesExecutive' },
    { grant: 'createPurchaseRequisition', to: ['SalesExecutive', 'SupplyChain'] },
    { grant: 'updateProcurement',          to: ['SupplyChain', 'JobScheduler'] }
  ]
  entity QuotationItems as projection on db.QuotationItems actions {
    action createPurchaseRequisition() returns QuotationItems;
    action updateProcurement(status : String(20), refDoc : String(10), expectedDate : Date)
                                       returns QuotationItems;
  };

  @readonly
  @restrict: [{ grant: 'READ', to: ['SalesExecutive', 'SalesManager', 'RegionalHead', 'SupplyChain', 'Auditor'] }]
  entity ProcurementEvents as projection on db.ProcurementEvents;

  @readonly
  @restrict: [{ grant: 'READ', to: ['SalesExecutive', 'SalesManager', 'RegionalHead', 'Auditor'] }]
  entity ApprovalHistory as projection on db.ApprovalHistory;

  @readonly
  @restrict: [{ grant: 'READ', to: ['Auditor', 'RegionalHead'] }]
  entity AuditLog as projection on db.AuditLog;

  @restrict: [{ to: ['SalesManager', 'RegionalHead'] }]
  function myApprovals() returns many Quotations;
}

// System-controlled fields cannot be written by the client
annotate QuotationService.Quotations with {
  quotationNo           @readonly;
  status                @readonly;
  netValue              @readonly;
  taxValue              @readonly;
  totalValue            @readonly;
  approvalLevelRequired @readonly;
  s4SalesOrderNo        @readonly;
};

annotate QuotationService.QuotationItems with {
  basePrice         @readonly;
  marginPct         @readonly;
  netPrice          @readonly;
  lineTotal         @readonly;
  thresholdBreached @readonly;
  deviationPct      @readonly;
  stockStatus       @readonly;
  availableQty      @readonly;
  procurementStatus @readonly;
  prNumber          @readonly;
  poNumber          @readonly;
  expectedDate      @readonly;
};