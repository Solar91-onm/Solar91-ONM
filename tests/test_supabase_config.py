from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.config import Settings


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://example-project.supabase.co", "https://example-project.supabase.co"),
        ("  'https://example-project.supabase.co/'  ", "https://example-project.supabase.co"),
        ("http://localhost:54321/", "http://localhost:54321"),
        ("", ""),
        (None, None),
    ],
)
def test_supabase_url_accepts_project_base_urls(value, expected):
    settings = Settings(_env_file=None, supabase_url=value)

    assert settings.supabase_url == expected


@pytest.mark.parametrize(
    "value",
    [
        "https://example-project.supabase.co/rest/v1",
        "https://example-project.supabase.co/auth/v1",
        "https://example-project.supabase.co?query=value",
        "https://example-project.supabase.co#fragment",
        "https://user:password@example-project.supabase.co",
        "http://example-project.supabase.co",
        "ftp://example-project.supabase.co",
        "not-a-url",
        "https://example-project.supabase.co:bad",
    ],
)
def test_supabase_url_rejects_malformed_or_nonbase_urls_without_echoing_value(value):
    with pytest.raises(ValidationError) as error:
        Settings(_env_file=None, supabase_url=value)

    assert value not in str(error.value)
