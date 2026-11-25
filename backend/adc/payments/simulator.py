from dataclasses import dataclass
from decimal import Decimal
import logging

from django.conf import settings
from django.db import transaction

from adc.common.idempotency import canonical_digest


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PaymentOperation:
    kind: str
    id: int
    amount: Decimal
    key: str
    source_id: int | None = None


@dataclass(frozen=True)
class PaymentReceipt:
    operation: PaymentOperation
    outcome: str
    reference: str


class SimulatedGateway:
    terminal_outcomes = {"SUCCEEDED", "FAILED"}

    def deliver(self, operation: PaymentOperation) -> PaymentReceipt | None:
        configured = settings.ADC_SIMULATION_OUTCOMES
        outcome = configured.get(f"{operation.kind}:{operation.id}", configured.get(operation.kind, "SUCCEEDED"))
        if outcome == "DEFERRED":
            return None
        if outcome not in self.terminal_outcomes:
            raise ValueError("Unknown synthetic payment outcome")
        return PaymentReceipt(operation, outcome, self.reference(operation, outcome))

    def matches(self, operation, receipt):
        return (
            receipt.operation == operation
            and receipt.outcome in self.terminal_outcomes
            and receipt.reference == self.reference(operation, receipt.outcome)
        )

    def reference(self, operation, outcome):
        return "sim:" + canonical_digest([
            operation.kind, operation.id, operation.source_id,
            format(operation.amount, ".2f"), operation.key, outcome,
        ])


def dispatch_after_commit(operation, receive):
    def deliver():
        if settings.ADC_SIMULATION_PAUSED:
            return
        try:
            receipt = SimulatedGateway().deliver(operation)
            if receipt is not None:
                receive(receipt)
        except Exception as error:
            logger.error(
                "ADC simulated operation %s %s deferred after %s",
                operation.kind, operation.id, type(error).__name__,
            )

    transaction.on_commit(deliver, using="default")
