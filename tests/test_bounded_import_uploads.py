from __future__ import annotations

import pytest
from starlette.datastructures import UploadFile

from app.core.config import get_settings
from tests.conftest import login_user


@pytest.mark.parametrize(
    ("path", "max_bytes"),
    [
        ("/api/imports/plants", get_settings().max_upload_mb * 1024 * 1024),
        ("/api/imports/locations", get_settings().max_upload_mb * 1024 * 1024),
        ("/api/users/import", get_settings().max_upload_mb * 1024 * 1024),
        ("/api/pm-plan/import", 5 * 1024 * 1024),
    ],
)
def test_spreadsheet_imports_read_only_one_byte_over_limit(
    client, db, monkeypatch, path, max_bytes
):
    login_user(client, db)
    requested_sizes = []

    async def bounded_read(file, size=-1):
        requested_sizes.append(size)
        return b"x" * (size if size > 0 else max_bytes + 1)

    monkeypatch.setattr(UploadFile, "read", bounded_read)
    response = client.post(path, files={"file": ("oversized.csv", b"x", "text/csv")})

    assert response.status_code == 413, response.text
    assert requested_sizes == [max_bytes + 1]
