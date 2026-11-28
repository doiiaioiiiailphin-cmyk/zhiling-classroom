"""TLS CA bundle environment sanitization and SSLContext resolution."""
from __future__ import annotations

import os
from pathlib import Path
import ssl


_CA_FILE_ENV_KEYS = ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE")


def sanitize_tls_env() -> None:
    """Remove stale CA environment variables pointing to missing files or directories."""
    for key in _CA_FILE_ENV_KEYS:
        raw = os.environ.get(key)
        if raw is not None and (not raw.strip() or not Path(raw).is_file()):
            os.environ.pop(key, None)

    raw_dir = os.environ.get("SSL_CERT_DIR")
    if raw_dir is not None and (not raw_dir.strip() or not Path(raw_dir).is_dir()):
        os.environ.pop("SSL_CERT_DIR", None)


def resolve_certifi_ca_file() -> str | None:
    """Return certifi CA bundle path only when it exists on disk."""
    try:
        import certifi  # type: ignore

        ca_file = certifi.where()
        if ca_file and Path(ca_file).is_file():
            return str(ca_file)
    except Exception:
        pass
    return None


def configure_tls_ca_bundle() -> None:
    """Sanitize TLS env vars and bind existing certifi CA bundle when available."""
    sanitize_tls_env()
    existing = os.environ.get("SSL_CERT_FILE")
    if existing:
        os.environ.setdefault("REQUESTS_CA_BUNDLE", existing)
        return
    ca_file = resolve_certifi_ca_file()
    if ca_file:
        os.environ["SSL_CERT_FILE"] = ca_file
        os.environ.setdefault("REQUESTS_CA_BUNDLE", ca_file)


def build_tls_ssl_context() -> ssl.SSLContext:
    """Build an SSLContext using valid env/certifi CA paths or the OS trust store."""
    sanitize_tls_env()
    env_ca = os.environ.get("SSL_CERT_FILE")
    if env_ca:
        return ssl.create_default_context(cafile=env_ca)
    env_dir = os.environ.get("SSL_CERT_DIR")
    if env_dir:
        return ssl.create_default_context(capath=env_dir)
    certifi_ca = resolve_certifi_ca_file()
    if certifi_ca:
        return ssl.create_default_context(cafile=certifi_ca)
    return ssl.create_default_context()
