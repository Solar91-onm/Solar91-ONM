from __future__ import annotations

import base64
import binascii
from functools import lru_cache
import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
    )

    app_name: str = "Solar91 O&M Command Center"
    app_env: Literal["development", "test", "production"] = "development"
    debug: bool = False
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/postgres"

    # Supabase provides PostgreSQL and Storage. Clerk is the identity provider.
    supabase_url: str | None = None
    # Server-only Supabase Storage credential. This is NOT used for login/authentication.
    supabase_service_role_key: str | None = None
    supabase_storage_bucket: str = "scheduled-om-evidence"

    clerk_publishable_key: str = ""
    clerk_secret_key: str = ""
    clerk_issuer: str = ""

    bootstrap_admin_emails: str = ""
    # False (default): only people already added to the users table (or listed in BOOTSTRAP_ADMIN_EMAILS) may sign in.
    # True: any verified Clerk user is auto-created as a role-less "Viewer".
    allow_unregistered_signin: bool = False

    # Invite e-mails (Resend, https://resend.com). Leave empty to disable sending.
    resend_api_key: str = ""
    mail_from: str = ""  # e.g. "Solar91 <invites@yourdomain.com>" (domain must be verified in Resend)
    app_public_url: str = ""  # link used in e-mails, e.g. https://solar91-om.onrender.com

    allowed_origins: str = "http://localhost:8000,http://127.0.0.1:8000"
    trust_proxy_headers: bool = False
    max_upload_mb: int = 4

    # Persistent hosted service: keep the application-side DB pool deliberately small.
    db_pool_size: int = 5
    db_max_overflow: int = 2
    # Replace pooled connections after 30 minutes. Each new connection costs several network round trips (TCP, TLS,
    # login), so recycling every few minutes made page loads pay for reconnects. Dead connections are still caught by
    # the health check below, whatever this value is.
    db_pool_recycle_seconds: int = 1800
    db_pool_timeout_seconds: int = 30  # how long a request waits for a free connection before failing
    # True = test each pooled connection before use (one extra round trip per request; safest). Set DB_POOL_PRE_PING=false
    # only after measuring that the round trip matters AND the pooler does not drop idle connections.
    db_pool_pre_ping: bool = True
    # With pre-ping on, skip the test for a connection used within this many seconds (it cannot have gone stale yet);
    # this removes one database round trip from most requests of a page load. 0 = test before every use, as before.
    db_ping_idle_seconds: float = 10
    slow_request_ms: int = 1000  # requests slower than this are logged with their database query count/time
    state_sync_enabled: bool = True
    # 0 = send every issue to the browser. Set e.g. 365 to leave out tickets closed more than a year ago
    # (they stay in the database and in /api/issues). Recommended once total issues pass ~20,000.
    bootstrap_closed_issue_days: int = 0
    # Finished (Completed / Cancelled) PM work orders older than this many days are not sent at sign-in or by
    # GET /api/scheduled/tasks; open work always is. They stay in the database and /api/scheduled/tasks?history=all.
    # 0 = send every record (the behaviour before October 2026). See app/scheduled/history.py.
    bootstrap_pm_history_days: int = 180
    # Retained for backwards-compatible config parsing. Full bootstrap includes washing because legacy views,
    # dashboards, reports, and the PM Excel export consume it; lite refreshes omit it explicitly.
    bootstrap_include_washing: bool = True

    scada_base_url: str | None = None
    scada_telemetry_path: str = "/telemetry"
    scada_api_token: str | None = None
    scada_timeout_seconds: float = 10.0

    @field_validator("database_url", mode="before")
    @classmethod
    def _normalize_database_url(cls, value):
        """Accept the URL exactly as Supabase shows it (postgresql:// or postgres://) and use the psycopg 3 driver.

        Without this, a plain postgresql:// URL makes SQLAlchemy import psycopg2, which is not installed,
        and the whole deployment exits at start-up. Surrounding spaces/quotes pasted into Render are removed too.
        """
        if not isinstance(value, str):
            return value
        value = value.strip().strip("\"'").strip()
        for old, new in (("postgresql://", "postgresql+psycopg://"), ("postgres://", "postgresql+psycopg://")):
            if value.startswith(old):
                return new + value[len(old):]
        return value

    @field_validator("supabase_url", mode="before")
    @classmethod
    def _validate_supabase_url(cls, value):
        """Accept only a Supabase project origin, never a REST/Auth endpoint or secret-bearing URL."""
        if value is None:
            return None
        if not isinstance(value, str):
            return value
        value = value.strip().strip("\"'").strip()
        if not value:
            return value

        try:
            parsed = urlsplit(value)
            hostname = parsed.hostname
            parsed.port
        except ValueError as exc:
            raise ValueError("SUPABASE_URL must be a valid project base URL.") from exc

        local_http = hostname in {"localhost", "127.0.0.1", "::1"}
        if (
            parsed.scheme not in ({"https", "http"} if local_http else {"https"})
            or not hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                "SUPABASE_URL must be an HTTPS project base URL without credentials, a path, query, or fragment."
            )

        return value.rstrip("/")

    @property
    def origins(self) -> list[str]:
        return [x.strip().rstrip("/") for x in self.allowed_origins.split(",") if x.strip()]

    @property
    def admin_emails(self) -> set[str]:
        return {x.strip().lower() for x in self.bootstrap_admin_emails.split(",") if x.strip()}

    @field_validator("clerk_issuer", mode="before")
    @classmethod
    def _validate_clerk_issuer(cls, value):
        if value is None:
            return ""
        if not isinstance(value, str):
            return value
        value = value.strip().strip("\"'").strip()
        if not value:
            return value
        try:
            parsed = urlsplit(value)
            hostname = parsed.hostname
            parsed.port
        except ValueError as exc:
            raise ValueError("CLERK_ISSUER must be a valid HTTPS origin.") from exc
        local_http = hostname in {"localhost", "127.0.0.1", "::1"}
        if (
            parsed.scheme not in ({"https", "http"} if local_http else {"https"})
            or not hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("CLERK_ISSUER must be an HTTPS origin without credentials, a path, query, or fragment.")
        return value.rstrip("/")

    @property
    def clerk_configured(self) -> bool:
        issuer_host = urlsplit(self.clerk_issuer).netloc.casefold()
        return bool(
            self.clerk_publishable_key.strip()
            and self.clerk_secret_key.strip()
            and self.clerk_issuer
            and self.clerk_frontend_api
            and issuer_host == self.clerk_frontend_api.casefold()
        )

    @property
    def clerk_frontend_api(self) -> str | None:
        parts = self.clerk_publishable_key.strip().split("_", 2)
        if len(parts) != 3 or parts[0] != "pk" or parts[1] not in {"test", "live"}:
            return None
        encoded_domain = parts[2]
        try:
            decoded = base64.b64decode(encoded_domain + "=" * (-len(encoded_domain) % 4), altchars=b"-_", validate=True)
        except (ValueError, binascii.Error):
            return None
        domain = decoded.decode("ascii", errors="ignore").rstrip("$")
        if not re.fullmatch(r"[A-Za-z0-9.-]+(?::[0-9]{1,5})?", domain):
            return None
        return domain.lower()

    @property
    def auth_configured(self) -> bool:
        return self.clerk_configured

    @property
    def storage_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_service_role_key and self.supabase_storage_bucket)


@lru_cache
def get_settings() -> Settings:
    return Settings()