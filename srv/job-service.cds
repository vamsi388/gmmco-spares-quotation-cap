@path: '/odata/v4/job'
@requires: 'JobScheduler'
service JobService {
  action expireQuotations() returns String;
  action sendReminders()    returns String;
  action syncProcurement()  returns String;
}