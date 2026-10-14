import asyncio

from app.main import app


def test_app_waits_for_deploy_setup_before_serving(client, monkeypatch):
    monkeypatch.setattr("app.main.settings.app_env", "production")
    original_ready = app.state.bootstrap_ready
    app.state.bootstrap_ready = False
    try:
        assert client.get("/").status_code == 503
        response = client.get("/health/ready")
        assert response.status_code == 503
        assert response.json() == {"status": "initializing"}

        app.state.bootstrap_ready = True
        assert client.get("/health/ready").status_code == 200
    finally:
        app.state.bootstrap_ready = original_ready


def test_readiness_reports_database_failure_without_marking_app_ready(
    client, monkeypatch
):
    from sqlalchemy.exc import OperationalError

    from app.core.database import engine

    original_ready = app.state.bootstrap_ready
    app.state.bootstrap_ready = True
    monkeypatch.setattr(
        engine,
        "connect",
        lambda: (_ for _ in ()).throw(
            OperationalError("select 1", {}, RuntimeError("simulated outage"))
        ),
    )
    try:
        response = client.get("/health/ready")
        assert response.status_code == 503
        assert response.json() == {"status": "database_unreachable"}
        assert "simulated outage" not in response.text
    finally:
        app.state.bootstrap_ready = original_ready


def test_deploy_setup_retries_transient_dependency_failure(monkeypatch):
    import app.main as main_module

    original_ready = app.state.bootstrap_ready
    app.state.bootstrap_ready = False
    calls = []
    delays = []

    async def run_script(script):
        calls.append(script)
        if len(calls) == 1:
            return 3
        return 0

    async def sleep(delay):
        delays.append(delay)

    monkeypatch.setattr(main_module, "_run_setup_script", run_script)
    monkeypatch.setattr(main_module.asyncio, "sleep", sleep)
    try:
        asyncio.run(main_module._run_deploy_setup())
        assert calls == ["preflight.py", "preflight.py", "ensure_storage.py"]
        assert delays == [main_module.SETUP_RETRY_INITIAL_SECONDS]
        assert app.state.bootstrap_ready is True
    finally:
        app.state.bootstrap_ready = original_ready


def test_deploy_setup_does_not_retry_permanent_configuration_failure(monkeypatch):
    import app.main as main_module

    original_ready = app.state.bootstrap_ready
    app.state.bootstrap_ready = False
    calls = []

    async def run_script(script):
        calls.append(script)
        return 2

    async def sleep(_delay):
        raise AssertionError("Permanent configuration failure must not retry.")

    monkeypatch.setattr(main_module, "_run_setup_script", run_script)
    monkeypatch.setattr(main_module.asyncio, "sleep", sleep)
    try:
        asyncio.run(main_module._run_deploy_setup())
        assert calls == ["preflight.py"]
        assert app.state.bootstrap_ready is False
    finally:
        app.state.bootstrap_ready = original_ready
