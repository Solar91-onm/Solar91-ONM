"""scripts/migrate.py must never run the full historical migration set against a populated database."""
import importlib.util
from pathlib import Path

from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parents[1]


def _load():
    spec = importlib.util.spec_from_file_location("migrate_under_test", ROOT / "scripts" / "migrate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _settings(monkeypatch, url):
    import app.core.config as config

    class FakeSettings:
        database_url = url

    monkeypatch.setattr(config, "get_settings", lambda: FakeSettings())


def test_migrate_refuses_populated_database_and_changes_nothing(tmp_path, monkeypatch):
    url = "sqlite:///" + (tmp_path / "populated.sqlite3").as_posix()
    with create_engine(url).begin() as conn:
        conn.execute(text("create table users (id integer primary key)"))
    _settings(monkeypatch, url)
    assert _load().main([]) == 2
    with create_engine(url).connect() as conn:
        tables = {r[0] for r in conn.execute(text("select name from sqlite_master where type='table'"))}
    assert tables == {"users"}


def test_migrate_check_mode_is_read_only(tmp_path, monkeypatch, capsys):
    url = "sqlite:///" + (tmp_path / "empty.sqlite3").as_posix()
    _settings(monkeypatch, url)
    assert _load().main(["--check"]) == 0
    out = capsys.readouterr().out
    assert "present: none" in out and "nothing was changed" in out
    with create_engine(url).connect() as conn:
        assert not list(conn.execute(text("select name from sqlite_master where type='table'")))
