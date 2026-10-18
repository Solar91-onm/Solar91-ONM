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


def test_readiness_reports_missing_schema_without_marking_app_ready(client, monkeypatch):
    import app.main as main_module

    original_ready = app.state.bootstrap_ready
    app.state.bootstrap_ready = True

    class NoTables:
        def has_table(self, _name):
            return False

    monkeypatch.setattr(main_module, "sa_inspect", lambda _conn: NoTables())
    try:
        response = client.get("/health/ready")
        assert response.status_code == 503
        assert response.json() == {"status": "schema_missing"}
    finally:
        app.state.bootstrap_ready = original_ready


def test_missing_core_table_error_returns_clear_503_message(client, monkeypatch):
    from sqlalchemy.exc import ProgrammingError

    def boom():
        raise ProgrammingError("SELECT users.id FROM users", {}, RuntimeError('relation "users" does not exist'))

    route = "/api/__schema_probe"
    app.add_api_route(route, boom, methods=["GET"])
    try:
        response = client.get(route)
        assert response.status_code == 503
        assert response.json()["error"] == "database_schema_missing"
        assert "relation" not in response.text
    finally:
        app.router.routes = [r for r in app.router.routes if getattr(r, "path", None) != route]


def test_preflight_lists_missing_core_tables():
    import importlib.util
    from pathlib import Path
    from sqlalchemy import create_engine, text

    spec = importlib.util.spec_from_file_location("preflight_under_test", Path(__file__).resolve().parents[1] / "scripts" / "preflight.py")
    preflight = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(preflight)
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("create table users (id integer primary key)"))
        assert preflight.missing_core_tables(conn) == ["plants", "issues", "om_tasks"]
