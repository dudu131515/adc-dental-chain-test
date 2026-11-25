from argparse import ArgumentTypeError

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from adc.booking.deposit_service import deposit_operation, receive_deposit, receive_refund, refund_operation
from adc.booking.models import DepositPayment, DepositRefund
from adc.billing.invoice_service import payment_operation, receive_payment
from adc.billing.models import InvoicePayment
from adc.billing.refund_service import needs_reconciliation
from adc.billing.refund_service import receive_refund as receive_invoice_refund
from adc.billing.refund_service import refund_operation as invoice_refund_operation
from adc.payments.simulator import dispatch_after_commit


OBLIGATION_TYPES = {"deposit", "deposit_refund", "invoice_payment", "invoice_refund"}


def obligation(value):
    kind, _, key = value.partition(":")
    if kind not in OBLIGATION_TYPES or not key.isascii() or not key.isdecimal() or len(key) > 19:
        raise ArgumentTypeError("Expected a known obligation category followed by its numeric ID.")
    identifier = int(key)
    if not 0 < identifier < 2**63:
        raise ArgumentTypeError("Obligation ID must be a positive PostgreSQL bigint.")
    return kind, identifier


class Command(BaseCommand):
    help = "Resume pending synthetic funding records using their stored operation IDs."

    def add_arguments(self, parser):
        parser.add_argument(
            "--obligation", action="append", type=obligation, metavar="KIND:ID",
            help="Replay only a verified original obligation. Repeat for each reconciled record.",
        )

    def handle(self, **options):
        if settings.ADC_SIMULATION_PAUSED:
            raise CommandError("Synthetic funding is paused. Verify the original obligations before resuming.")
        selected = options.get("obligation")
        invoice = InvoicePayment.objects.filter(status="PENDING")
        sources = (
            ("deposit", DepositPayment.objects.filter(status="PENDING", payment_token__isnull=False),
             deposit_operation, receive_deposit),
            ("deposit_refund", DepositRefund.objects.filter(status="PENDING"), refund_operation, receive_refund),
            ("invoice_payment", invoice.filter(payment_kind="PAYMENT"), payment_operation, receive_payment),
            ("invoice_refund", invoice.filter(payment_kind="REFUND"), invoice_refund_operation, receive_invoice_refund),
        )
        checked = 0
        for kind, rows, operation, receive in sources:
            if selected is not None:
                rows = rows.filter(pk__in={key for category, key in selected if category == kind})
            for row in rows.order_by("pk").iterator():
                if kind == "invoice_refund" and needs_reconciliation(row.pk):
                    continue
                dispatch_after_commit(operation(row), receive)
                checked += 1
        self.stdout.write(f"Checked {checked} pending synthetic funding operations.")
