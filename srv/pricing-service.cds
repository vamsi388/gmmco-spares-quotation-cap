using gmmco.quotation as db from '../db/schema';

@path: '/odata/v4/pricing'
@requires: 'authenticated-user'
service PricingService {

  @restrict: [
    { grant: 'READ', to: ['PricingAdmin', 'SalesExecutive', 'SalesManager', 'RegionalHead', 'SupplyChain', 'Auditor'] },
    { grant: '*',    to: 'PricingAdmin' }
  ]
  entity PricingConfigs as projection on db.PricingConfigs actions {
    action activate()   returns PricingConfigs;
    action deactivate() returns PricingConfigs;
  };
}