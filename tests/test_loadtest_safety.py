from __future__ import annotations

import ast
from uuid import uuid4
from pathlib import Path

import pytest

from loadtests.safety import (
    LoadTestSafetyError,
    load_config,
    validate_active_target,
)

ROOT = Path(__file__).resolve().parents[1]


def _staging_env() -> dict[str, str]:
    return {
        "SOLAR91_LOADTEST_ENV": "staging",
        "SOLAR91_LOADTEST_CONFIRM_STAGING": "I_VERIFIED_THIS_IS_STAGING",
        "SOLAR91_LOADTEST_SYNTHETIC_ONLY": "I_VERIFIED_SYNTHETIC_ONLY",
        "SOLAR91_LOADTEST_BASE_URL": "https://solar91-qa.example.test",
        "SOLAR91_LOADTEST_APPROVED_HOST": "solar91-qa.example.test",
        "SOLAR91_LOADTEST_PRODUCTION_HOSTS": "solar91.example.com,solar91-om.onrender.com",
        "SOLAR91_LOADTEST_BEARER_TOKEN": "do-not-print-test-token",
        "SOLAR91_LOADTEST_PLANT_ID": str(uuid4()),
        "SOLAR91_LOADTEST_PLANT_SITE_CODE": "QA-SYNTHETIC-1",
        "SOLAR91_LOADTEST_ASSIGNEE_ID": str(uuid4()),
        "SOLAR91_LOADTEST_RUN_ID": "qa-run-2026",
    }


def test_loadtest_python_scripts_are_syntactically_valid():
    for relative_path in (
        "loadtests/safety.py",
        "loadtests/run_locust.py",
        "loadtests/locustfile.py",
    ):
        ast.parse((ROOT / relative_path).read_text(encoding="utf-8"), filename=relative_path)


def test_loadtest_config_accepts_confirmed_nonproduction_target_without_exposing_token():
    config = load_config(_staging_env())

    assert config.base_url == "https://solar91-qa.example.test"
    assert config.issue_prefix == "LT-qa-run-2026-"
    assert "do-not-print-test-token" not in repr(config)
    validate_active_target(config.base_url, config)
    validate_active_target(config.base_url + "/", config)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("SOLAR91_LOADTEST_ENV", "production"),
        ("SOLAR91_LOADTEST_CONFIRM_STAGING", ""),
        ("SOLAR91_LOADTEST_SYNTHETIC_ONLY", ""),
        ("SOLAR91_LOADTEST_PRODUCTION_HOSTS", ""),
        ("SOLAR91_LOADTEST_BEARER_TOKEN", ""),
    ],
)
def test_loadtest_config_fails_closed_when_safety_confirmation_is_missing(key, value):
    env = _staging_env()
    env[key] = value

    with pytest.raises(LoadTestSafetyError):
        load_config(env)


@pytest.mark.parametrize(
    "url",
    [
        "http://solar91-qa.example.test",
        "https://solar91-qa.example.test/rest/v1",
        "https://user:password@solar91-qa.example.test",
        "https://solar91-om.onrender.com",
        "https://solar91-qa.example.test?debug=1",
    ],
)
def test_loadtest_config_rejects_unsafe_or_production_targets(url):
    env = _staging_env()
    env["SOLAR91_LOADTEST_BASE_URL"] = url
    env["SOLAR91_LOADTEST_APPROVED_HOST"] = "solar91-qa.example.test"

    with pytest.raises(LoadTestSafetyError):
        load_config(env)


def test_active_locust_host_must_match_the_approved_staging_url():
    config = load_config(_staging_env())

    with pytest.raises(LoadTestSafetyError, match="active host differs"):
        validate_active_target("https://solar91-om.onrender.com", config)


def test_known_render_production_host_is_blocked_even_if_misapproved():
    env = _staging_env()
    env["SOLAR91_LOADTEST_BASE_URL"] = "https://solar91-om.onrender.com"
    env["SOLAR91_LOADTEST_APPROVED_HOST"] = "solar91-om.onrender.com"
    env["SOLAR91_LOADTEST_PRODUCTION_HOSTS"] = "solar91-qa.example.test"

    with pytest.raises(LoadTestSafetyError, match="listed as production"):
        load_config(env)


def test_evidence_upload_requires_private_bucket_confirmation():
    env = _staging_env()
    env["SOLAR91_LOADTEST_UPLOAD_EVIDENCE"] = "yes"

    with pytest.raises(LoadTestSafetyError, match="private staging Storage bucket"):
        load_config(env)
