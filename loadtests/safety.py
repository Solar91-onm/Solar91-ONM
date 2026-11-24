from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit
from uuid import UUID


class LoadTestSafetyError(ValueError):
    """Raised when load-test target or data-isolation checks are not satisfied."""


KNOWN_PRODUCTION_HOSTS = frozenset({"solar91-om.onrender.com"})
REQUIRED_LOADTEST_PERMISSIONS = frozenset({
    "plants.view",
    "issues.view",
    "issues.create",
    "issues.manage",
    "issues.close",
})


def validate_loadtest_session(session: object) -> None:
    if not isinstance(session, dict) or session.get("authenticated") is not True:
        raise LoadTestSafetyError("The staging auth session returned an invalid response.")
    user = session.get("user")
    permissions = session.get("permissions")
    if not isinstance(user, dict) or user.get("role") != "O&M Head":
        raise LoadTestSafetyError("The load-test bearer token must belong to an active O&M Head.")
    if not isinstance(permissions, list) or not all(isinstance(item, str) for item in permissions):
        raise LoadTestSafetyError("The staging auth session did not return permissions.")
    missing = sorted(REQUIRED_LOADTEST_PERMISSIONS - set(permissions))
    if missing:
        raise LoadTestSafetyError(
            "The load-test O&M Head is missing required permissions: " + ", ".join(missing)
        )


@dataclass(frozen=True)
class LoadTestConfig:
    base_url: str
    bearer_token: str = field(repr=False)
    plant_id: str
    plant_site_code: str
    assignee_id: str
    run_id: str
    upload_evidence: bool
    evidence_bucket_private_acknowledged: bool
    max_rps: float

    @property
    def issue_prefix(self) -> str:
        return f"LT-{self.run_id}-"


def load_config(environ: dict[str, str] | None = None) -> LoadTestConfig:
    env = os.environ if environ is None else environ

    if env.get("SOLAR91_LOADTEST_ENV") != "staging":
        raise LoadTestSafetyError("SOLAR91_LOADTEST_ENV must be exactly 'staging'.")
    if env.get("SOLAR91_LOADTEST_CONFIRM_STAGING") != "I_VERIFIED_THIS_IS_STAGING":
        raise LoadTestSafetyError("Explicit staging-target confirmation is required.")
    if env.get("SOLAR91_LOADTEST_SYNTHETIC_ONLY") != "I_VERIFIED_SYNTHETIC_ONLY":
        raise LoadTestSafetyError("Explicit synthetic-only data confirmation is required.")

    raw_url = env.get("SOLAR91_LOADTEST_BASE_URL", "").strip()
    try:
        parsed = urlsplit(raw_url)
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port
    except ValueError as exc:
        raise LoadTestSafetyError("The configured staging URL is malformed.") from exc
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username
        or parsed.password
        or port not in (None, 443)
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise LoadTestSafetyError("The staging URL must be an HTTPS origin without credentials or a path.")

    approved_host = env.get("SOLAR91_LOADTEST_APPROVED_HOST", "").strip().lower().rstrip(".")
    if not approved_host or host != approved_host:
        raise LoadTestSafetyError("The staging URL host does not match the explicitly approved host.")

    blocked_hosts = {
        item.strip().lower().rstrip(".")
        for item in env.get("SOLAR91_LOADTEST_PRODUCTION_HOSTS", "").split(",")
        if item.strip()
    }
    if not blocked_hosts:
        raise LoadTestSafetyError("Configure production hostnames in SOLAR91_LOADTEST_PRODUCTION_HOSTS.")
    if host in blocked_hosts | KNOWN_PRODUCTION_HOSTS:
        raise LoadTestSafetyError("The configured host is listed as production and cannot receive load.")

    token = env.get("SOLAR91_LOADTEST_BEARER_TOKEN", "").strip()
    if not token:
        raise LoadTestSafetyError("A dedicated staging user's bearer token is required.")

    plant_id = _required_uuid(env, "SOLAR91_LOADTEST_PLANT_ID")
    assignee_id = _required_uuid(env, "SOLAR91_LOADTEST_ASSIGNEE_ID")
    site_code = env.get("SOLAR91_LOADTEST_PLANT_SITE_CODE", "").strip()
    if not site_code or len(site_code) > 80:
        raise LoadTestSafetyError("A staging synthetic plant site code is required.")

    run_id = env.get("SOLAR91_LOADTEST_RUN_ID", "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{3,31}", run_id):
        raise LoadTestSafetyError("The run ID must be 4-32 letters, digits, or hyphens.")

    upload_evidence = env.get("SOLAR91_LOADTEST_UPLOAD_EVIDENCE", "").strip().lower() == "yes"
    bucket_ack = env.get("SOLAR91_LOADTEST_EVIDENCE_BUCKET_PRIVATE") == "I_VERIFIED_PRIVATE_STAGING_BUCKET"
    if upload_evidence and not bucket_ack:
        raise LoadTestSafetyError(
            "Evidence uploads require explicit confirmation of the private staging Storage bucket."
        )

    max_rps_text = env.get("SOLAR91_LOADTEST_MAX_RPS", "5").strip()
    try:
        max_rps = float(max_rps_text)
    except ValueError as exc:
        raise LoadTestSafetyError("SOLAR91_LOADTEST_MAX_RPS must be between 0.1 and 50 requests per second.") from exc
    if not 0.1 <= max_rps <= 50:
        raise LoadTestSafetyError("SOLAR91_LOADTEST_MAX_RPS must be between 0.1 and 50 requests per second.")

    return LoadTestConfig(
        base_url=f"https://{parsed.netloc}",
        bearer_token=token,
        plant_id=plant_id,
        plant_site_code=site_code,
        assignee_id=assignee_id,
        run_id=run_id,
        upload_evidence=upload_evidence,
        evidence_bucket_private_acknowledged=bucket_ack,
        max_rps=max_rps,
    )


def validate_active_target(active_url: str, config: LoadTestConfig) -> None:
    if active_url.rstrip("/") != config.base_url:
        raise LoadTestSafetyError(
            "Locust's active host differs from the explicitly approved staging URL."
        )


def _required_uuid(env: dict[str, str], key: str) -> str:
    value = env.get(key, "").strip()
    try:
        return str(UUID(value))
    except (ValueError, AttributeError) as exc:
        raise LoadTestSafetyError(f"{key} must be a valid UUID from the staging environment.") from exc
