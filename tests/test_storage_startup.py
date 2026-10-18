from __future__ import annotations

from types import SimpleNamespace

import pytest

from scripts import ensure_storage


class FakeResponse:
    def __init__(self, status_code, *, public=None, body=b"", text="provider detail"):
        self.status_code = status_code
        self.content = body
        self.text = text
        self._public = public

    def json(self):
        return {"public": self._public}


class FakeStorageClient:
    response = None
    get_calls = []
    post_calls = []

    def __init__(self, timeout):
        assert timeout == 20.0

    def __enter__(self):
        type(self).get_calls = []
        type(self).post_calls = []
        return self

    def __exit__(self, *_exc):
        return False

    def get(self, url, *, headers):
        self.get_calls.append((url, headers))
        return self.response

    def post(self, *args, **kwargs):
        self.post_calls.append((args, kwargs))
        raise AssertionError("Startup must not create Storage buckets.")


@pytest.fixture
def storage_setup(monkeypatch, capsys):
    settings = SimpleNamespace(
        storage_configured=True,
        supabase_url="https://staging-project.supabase.co",
        supabase_storage_bucket="scheduled-om-evidence",
        supabase_service_role_key="test-only-key",
        max_upload_mb=4,
    )
    monkeypatch.setattr(ensure_storage, "get_settings", lambda: settings)
    monkeypatch.setattr(ensure_storage.httpx, "Client", FakeStorageClient)
    FakeStorageClient.response = None
    return capsys


@pytest.mark.parametrize("status_code", [400, 404])
def test_storage_startup_fails_missing_bucket_without_creating_it(
    storage_setup, status_code
):
    FakeStorageClient.response = FakeResponse(status_code)

    assert ensure_storage.main() == 5
    assert FakeStorageClient.post_calls == []
    assert "will not create or recreate it" in storage_setup.readouterr().out


def test_storage_startup_accepts_existing_private_bucket(storage_setup):
    FakeStorageClient.response = FakeResponse(200, public=False, body=b"{}")

    assert ensure_storage.main() == 0
    assert FakeStorageClient.post_calls == []


def test_storage_startup_rejects_public_bucket_without_changing_it(storage_setup):
    FakeStorageClient.response = FakeResponse(200, public=True, body=b"{}")

    assert ensure_storage.main() == 4
    assert FakeStorageClient.post_calls == []


def test_storage_startup_does_not_leak_provider_error_body(storage_setup):
    FakeStorageClient.response = FakeResponse(500, body=b"failure", text="secret provider detail")

    assert ensure_storage.main() == 3
    output = storage_setup.readouterr().out
    assert "HTTP 500" in output
    assert "secret provider detail" not in output
