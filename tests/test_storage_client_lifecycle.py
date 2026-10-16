from app.storage import service


def test_storage_http_client_is_reused_and_closed_cleanly():
    service.close_storage_http_client()

    first = service.get_storage_http_client()
    second = service.get_storage_http_client()
    assert first is second

    service.close_storage_http_client()
    assert first.is_closed

    reopened = service.get_storage_http_client()
    assert reopened is not first
    assert not reopened.is_closed
    service.close_storage_http_client()
