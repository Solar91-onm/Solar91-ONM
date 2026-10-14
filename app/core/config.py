from __future__ import annotations

from functools import lru_cache
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

    # Supabase provides PostgreSQL, Storage, and the only active user identity provider.
    supabase_url: str | None = None
    # This publishable key is intentionally sent to the browser; it is not a secret.
    supabase_anon_key: str | None = None
    # Server-only Supabase Storage credential. This is NOT used for login/authentication.
    supabase_service_role_key: str | None = None
    supabase_jwt_secret: str | None = None
    supabase_storage_bucket: str = "scheduled-om-evidence"

    bootstrap_admin_emails: str = ""

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
    db_pool_recycle_seconds: int = 300
    state_sync_enabled: bool = True
    # 0 = send every issue to the browser. Set e.g. 365 to leave out tickets closed more than a year ago
    # (they stay in the database and in /api/issues). Recommended once total issues pass ~20,000.
    bootstrap_closed_issue_days: int = 0

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

    @property
    def supabase_auth_issuer(self) -> str | None:
        if not self.supabase_url:
            return None
        base = self.supabase_url.rstrip("/")
        return f"{base}/auth/v1"

    @property
    def supabase_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_anon_key)

    @property
    def auth_configured(self) -> bool:
        return self.supabase_configured

    @property
    def storage_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_service_role_key and self.supabase_storage_bucket)


@lru_cache
def get_settings() -> Settings:
    return Settings()