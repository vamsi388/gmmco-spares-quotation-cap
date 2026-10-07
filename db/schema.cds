namespace gmmco.quotation;

using { cuid, managed, Currency } from '@sap/cds/common';

type Category     : String(10) enum { Part; Equipment; }
type ConfigStatus : String(10) enum { Active; Inactive; }
type QStatus      : String(12) enum {
  Draft; AwaitingStock; PendingL1; PendingL2; Approved; Rejected;
  Returned; Issued; Converted; Expired; Cancelled;
}
type StockStatus  : String(12) enum { Unknown; InStock; NotInStock; Partial; }
type ProcStatus   : String(20) enum {
  None; PRCreated; PRReleased; POCreated; SupplierConfirmed; Shipped; GRPosted;
}

entity PricingConfigs : cuid, managed {
  category          : Category not null;
  material          : String(40);
  materialGroup     : String(20);
  basePrice         : Decimal(15,2) not null;
  marginPct         : Decimal(5,2) default 0;
  maxDiscountPct    : Decimal(5,2) default 0;
  minPriceThreshold : Decimal(15,2);
  approvalL1Limit   : Decimal(5,2);
  approvalL2Limit   : Decimal(5,2);
  validFrom         : Date not null;
  validTo           : Date not null;
  currency          : Currency;
  status            : ConfigStatus default 'Inactive';
}

entity Quotations : cuid, managed {
  quotationNo           : String(20);
  status                : QStatus default 'Draft';
  customerId            : String(10) not null;
  customerName          : String(100);
  validFrom             : Date;
  validTo               : Date;
  currency              : Currency;
  netValue              : Decimal(15,2) default 0;
  taxValue              : Decimal(15,2) default 0;
  totalValue            : Decimal(15,2) default 0;
  approvalLevelRequired : Integer default 0;
  remarks               : String(500);
  s4SalesOrderNo        : String(10);
  items                 : Composition of many QuotationItems on items.quotation = $self;
  approvals             : Composition of many ApprovalHistory on approvals.quotation = $self;
}

entity QuotationItems : cuid {
  quotation         : Association to Quotations;
  itemNo            : Integer;
  material          : String(40) not null;
  description       : String(200);
  quantity          : Decimal(13,3) not null;
  uom               : String(3);
  // stock and procurement (steps 1-7 of the flow)
  stockStatus       : StockStatus default 'Unknown';
  availableQty      : Decimal(13,3);
  procurementStatus : ProcStatus default 'None';
  prNumber          : String(10);
  poNumber          : String(10);
  expectedDate      : Date;                 // supplier-confirmed delivery date
  // pricing (step 8)
  basePrice         : Decimal(15,2);
  marginPct         : Decimal(5,2);
  discountPct       : Decimal(5,2) default 0;
  netPrice          : Decimal(15,2);
  deliveryCost      : Decimal(15,2) default 0;
  lineTotal         : Decimal(15,2);
  thresholdBreached : Boolean default false;
  deviationPct      : Decimal(5,2) default 0;
}

entity ProcurementEvents : cuid {
  item      : Association to QuotationItems;
  event     : String(20);
  refDoc    : String(10);
  changedBy : String(100);
  changedAt : Timestamp;
}

entity ApprovalHistory : cuid {
  quotation : Association to Quotations;
  level     : Integer;
  approver  : String(100);
  action    : String(20);
  comments  : String(500);
  timestamp : Timestamp;
}

entity AuditLog : cuid {
  entity    : String(40);
  entityKey : String(40);
  field     : String(40);
  oldValue  : String(200);
  newValue  : String(200);
  changedBy : String(100);
  changedAt : Timestamp;
}

entity JobLog : cuid {
  jobName   : String(40);
  startedAt : Timestamp;
  status    : String(10);
  message   : String(500);
}

// ---- local mock master data (replace with S/4HANA APIs via Destination) ----
entity BusinessPartners {
  key bpId : String(10);
  name     : String(100);
  city     : String(40);
  country  : String(3);
}

entity Materials {
  key material  : String(40);
  description   : String(200);
  uom           : String(3);
  materialGroup : String(20);
}

entity MaterialStock {
  key material : String(40);
  key plant    : String(4);
  availableQty : Decimal(13,3);
}