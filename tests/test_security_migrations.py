from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_issue_detail_table_hardening_migration_is_additive_and_restrictive():
    migration = (
        ROOT / "database" / "migrations" / "029_issue_detail_tables_rls.sql"
    ).read_text(encoding="utf-8").lower()

    for table in ("public.issue_steps", "public.issue_etc_changes"):
        assert f"alter table if exists {table} enable row level security" in migration
    assert (
        "revoke all on table public.issue_steps, public.issue_etc_changes "
        "from public"
    ) in migration
    assert (
        "revoke all on table public.issue_steps, public.issue_etc_changes "
        "from anon"
    ) in migration
    assert (
        "revoke all on table public.issue_steps, public.issue_etc_changes "
        "from authenticated"
    ) in migration
    assert "drop " not in migration
    assert "delete " not in migration


def test_consolidated_supabase_sql_has_issue_detail_table_hardening():
    consolidated = (
        ROOT / "database" / "SUPABASE_RUN_THIS.sql"
    ).read_text(encoding="utf-8").lower()
    section = consolidated.split(
        "create index if not exists ix_issue_etc_changes_issue_changed_at", 1
    )[1].split("alter table issues add column if not exists fixed_on", 1)[0]

    assert "public.issue_steps enable row level security" in section
    assert "public.issue_etc_changes enable row level security" in section
    assert "from public" in section
    assert "from anon" in section
    assert "from authenticated" in section
