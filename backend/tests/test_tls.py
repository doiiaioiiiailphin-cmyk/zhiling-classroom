import os
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.tls import build_tls_ssl_context, configure_tls_ca_bundle, sanitize_tls_env


class TlsFallbackTests(unittest.TestCase):
    def test_sanitize_tls_env_removes_missing_paths_and_preserves_valid(self):
        with tempfile.TemporaryDirectory() as tmp:
            valid_ca = Path(tmp) / "valid-ca.pem"
            valid_ca.write_text("dummy", encoding="utf-8")
            valid_dir = Path(tmp) / "certs"
            valid_dir.mkdir()

            missing_ca = str(Path(tmp) / "missing-ca.pem")
            missing_dir = str(Path(tmp) / "missing-certs")

            with patch.dict(
                os.environ,
                {
                    "SSL_CERT_FILE": missing_ca,
                    "REQUESTS_CA_BUNDLE": str(valid_ca),
                    "CURL_CA_BUNDLE": "   ",
                    "SSL_CERT_DIR": missing_dir,
                },
                clear=False,
            ):
                sanitize_tls_env()
                self.assertNotIn("SSL_CERT_FILE", os.environ)
                self.assertEqual(os.environ.get("REQUESTS_CA_BUNDLE"), str(valid_ca))
                self.assertNotIn("CURL_CA_BUNDLE", os.environ)
                self.assertNotIn("SSL_CERT_DIR", os.environ)

                os.environ["SSL_CERT_FILE"] = str(valid_ca)
                os.environ["SSL_CERT_DIR"] = str(valid_dir)
                sanitize_tls_env()
                self.assertEqual(os.environ.get("SSL_CERT_FILE"), str(valid_ca))
                self.assertEqual(os.environ.get("SSL_CERT_DIR"), str(valid_dir))

    def test_build_tls_ssl_context_falls_back_to_os_store_when_certifi_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing_ca = str(Path(tmp) / "missing-cacert.pem")
            with (
                patch.dict(
                    os.environ,
                    {
                        "SSL_CERT_FILE": missing_ca,
                        "REQUESTS_CA_BUNDLE": missing_ca,
                        "SSL_CERT_DIR": str(Path(tmp) / "no-such-dir"),
                    },
                    clear=False,
                ),
                patch("backend.app.tls.resolve_certifi_ca_file", return_value=None),
            ):
                ctx = build_tls_ssl_context()
                self.assertIsInstance(ctx, ssl.SSLContext)
                self.assertNotIn("SSL_CERT_FILE", os.environ)
                self.assertNotIn("REQUESTS_CA_BUNDLE", os.environ)
                self.assertNotIn("SSL_CERT_DIR", os.environ)

                configure_tls_ca_bundle()
                self.assertNotIn("SSL_CERT_FILE", os.environ)

    def test_create_app_lifespan_starts_when_certifi_and_ssl_cert_file_are_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing_ca = str(Path(tmp) / "corrupted-internal" / "certifi" / "cacert.pem")
            with (
                patch.dict(os.environ, {"SSL_CERT_FILE": missing_ca, "REQUESTS_CA_BUNDLE": missing_ca}, clear=False),
                patch("certifi.where", return_value=missing_ca),
            ):
                app = create_app(
                    data_dir=Path(tmp) / "data",
                    enable_os_hotkeys=False,
                    serve_dist=False,
                )
                with TestClient(app, base_url="http://localhost") as client:
                    resp = client.get("/api/v1/sessions")
                    self.assertEqual(resp.status_code, 200)
                    self.assertEqual(resp.json(), {"data": []})


if __name__ == "__main__":
    unittest.main()
