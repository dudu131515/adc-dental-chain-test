import os
from pathlib import Path
import subprocess
import sys
import unittest


BACKEND = Path(__file__).resolve().parents[1]


class SettingsTests(unittest.TestCase):
    def run_django(self, args, **settings):
        environment = {
            k: v for k, v in os.environ.items()
            if not k.startswith("ADC_") and k != "DJANGO_SETTINGS_MODULE"
        }
        return subprocess.run(
            [sys.executable, str(BACKEND / "manage.py"), *args],
            env={**environment, **settings},
            cwd=BACKEND,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

    def test_check_runs_with_explicit_local_configuration(self):
        result = self.run_django(["check"], ADC_ENV="local", ADC_SECRET_KEY="settings-test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no issues", result.stdout)

    def test_missing_signing_key_fails_with_configuration_name(self):
        result = self.run_django(["check"], ADC_ENV="local")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ADC_SECRET_KEY", result.stderr)

    def test_experience_requires_connection_settings(self):
        result = self.run_django(
            ["check"], ADC_ENV="experience", ADC_SECRET_KEY="never-print-this-signing-key"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ADC_BUSINESS_DB_URL", result.stderr)
        self.assertNotIn("never-print-this-signing-key", result.stderr)

    def test_local_business_time_zone_and_database_separation(self):
        result = self.run_django(
            ["shell", "-c", "from django.conf import settings; print(settings.TIME_ZONE, settings.DATABASES['default']['NAME'], settings.DATABASES['runtime']['NAME'])"],
            ADC_ENV="local",
            ADC_SECRET_KEY="settings-test",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Asia/Shanghai adc_business adc_runtime", result.stdout)
