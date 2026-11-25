from dataclasses import replace
from decimal import Decimal

from django.db import transaction
from django.test import SimpleTestCase, TransactionTestCase, override_settings


class SimulatorContractTests(SimpleTestCase):
    @override_settings(ADC_SIMULATION_OUTCOMES={"deposit:44": "DEFERRED"})
    def test_deferred_result_requires_polling_and_rejects_an_unrelated_origin(self):
        from adc.payments.simulator import PaymentOperation, SimulatedGateway

        operation = PaymentOperation("deposit", 44, Decimal("50.00"), "clinical-demo-key")
        gateway = SimulatedGateway()
        self.assertIsNone(gateway.deliver(operation))
        with override_settings(ADC_SIMULATION_OUTCOMES={"deposit:44": "SUCCEEDED"}):
            receipt = gateway.deliver(operation)
            self.assertEqual(receipt.outcome, "SUCCEEDED")
            self.assertTrue(gateway.matches(operation, receipt))
            self.assertFalse(gateway.matches(replace(operation, amount=Decimal("49.00")), receipt))
            self.assertEqual(gateway.deliver(operation), receipt)


class PaymentDispatchTests(TransactionTestCase):
    def test_dispatch_only_occurs_after_business_commit(self):
        from adc.payments.simulator import PaymentOperation, dispatch_after_commit

        delivered = []
        operation = PaymentOperation("deposit_refund", 42, Decimal("50.00"), "refund-durable-key", 14)
        with transaction.atomic():
            dispatch_after_commit(operation, delivered.append)
            self.assertEqual(delivered, [])
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0].operation.source_id, 14)
        with transaction.atomic():
            dispatch_after_commit(operation, delivered.append)
            transaction.set_rollback(True)
        self.assertEqual(len(delivered), 1)
