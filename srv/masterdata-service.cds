using gmmco.quotation as db from '../db/schema';

// Read-only proxy. Local mock tables now; S/4HANA Business Partner / Material APIs later.
@path: '/odata/v4/masterdata'
@requires: 'authenticated-user'
service MasterDataService {
  @readonly entity BusinessPartners as projection on db.BusinessPartners;
  @readonly entity Materials        as projection on db.Materials;
}