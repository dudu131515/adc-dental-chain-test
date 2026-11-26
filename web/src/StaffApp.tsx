import { AccessPage } from "./features/admin/AccessPage";
import { BillingPage } from "./features/billing/BillingPage";
import { DailyReconciliation } from "./features/billing/DailyReconciliation";
import { DashboardPage, ManagementHome } from "./features/dashboard/DashboardPage";
import { PatientsPage } from "./features/patients/PatientsPage";
import { CatalogPage } from "./features/catalog/CatalogPage";
import { ClinicalWorkspace } from "./features/clinical/ClinicalQueue";
import { OperationsPage } from "./features/operations/OperationsPage";
import { SchedulePage } from "./features/schedule/SchedulePage";
import { AppShell, type SampleSession } from "./shared/AppShell";

export function StaffApp({ sample }: { sample?: SampleSession }) {
  return <AppShell sample={sample} renderWorkArea={area => {
    if (area.section === "/dashboard") return <ManagementHome {...area} />;
    if (area.path === "/schedule/today") return <DashboardPage {...area} />;
    if (area.section === "/patients") return <PatientsPage {...area} />;
    if (area.section === "/schedule") return <SchedulePage {...area} />;
    if (area.section === "/catalog") return <CatalogPage canEdit={area.identity.role_clinic_ids?.HQ_CATALOG === null} />;
    if (area.section === "/admin") return <AccessPage {...area} path={area.path === "/admin" ? "/admin/clinics" : area.path} />;
    if (area.section === "/operations") return <OperationsPage {...area} showTabs={false} />;
    if (area.section === "/billing") return area.path === "/billing/reconciliation"
      ? <DailyReconciliation {...area} /> : <BillingPage {...area} />;
    if (area.section === "/clinical") return <ClinicalWorkspace {...area} />;
    return null;
  }} />;
}
