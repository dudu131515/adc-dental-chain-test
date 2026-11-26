from django.urls import include, path, re_path

from adc.common.http import not_found


urlpatterns = [
    path("api/v1/", include("adc.identity.api")),
    path("api/v1/", include("adc.identity.workbench_api")),
    path("api/v1/", include("adc.scheduling.api")),
    path("api/v1/", include("adc.scheduling.resource_api")),
    path("api/v1/", include("adc.catalog.api")),
    path("api/v1/", include("adc.booking.patient_api")),
    path("api/v1/", include("adc.booking.hold_api")),
    path("api/v1/", include("adc.booking.appointment_query")),
    path("api/v1/", include("adc.booking.deposit_api")),
    path("api/v1/", include("adc.booking.reschedule_api")),
    path("api/v1/", include("adc.booking.cancellation_api")),
    path("api/v1/", include("adc.clinical.checkin_api")),
    path("api/v1/", include("adc.clinical.visit_api")),
    path("api/v1/", include("adc.clinical.visit_close_api")),
    path("api/v1/", include("adc.clinical.treatment_api")),
    path("api/v1/", include("adc.billing.invoice_api")),
    path("api/v1/", include("adc.billing.correction_api")),
    path("api/v1/", include("adc.billing.refund_api")),
    path("api/v1/", include("adc.reporting.expenses_api")),
    path("api/v1/", include("adc.reporting.calculation_api")),
    path("api/v1/", include("adc.reporting.version_api")),
    path("api/v1/", include("adc.reporting.operations_api")),
    path("api/v1/reports/operations/assistant/", include("adc.reporting.assistant_api")),
    re_path(r"^api/v1(?:/.*)?$", not_found),
]
