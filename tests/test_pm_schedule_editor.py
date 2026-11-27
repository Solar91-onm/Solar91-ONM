"""
Pure planner and route guards.

PostgreSQL transaction verification is separate.
"""

from datetime import date
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.core.models import Plant, PMUnitConfig
from app.pmplan import schedule_editor as ed
from app.pmplan.tracking import PMTrackingActivity
from tests.conftest import login_user


def row(
    equipment="Inverter",
    equipment_id="INV 1",
    day=1,
    **kw,
):
    return PMTrackingActivity(
        id=uuid4(),
        plant_id=uuid4(),
        equipment=equipment,
        equipment_id=equipment_id,
        scheduled_on=date(2026, 12, day),
        status=kw.pop("status", "Scheduled"),
        permission=kw.pop("permission", "None"),
        checklist=kw.pop("checklist", []),
        **kw,
    )


def test_irregular_grouped_and_clamped_days():
    changes = {
        ("Inverter", i): d
        for i, d in enumerate((1, 3, 5, 8), 1)
    }

    changes[("Earth pit", None)] = 31

    ops, skipped = ed._plan_operations(
        [date(2027, 2, 1), date(2028, 2, 1)],
        changes,
        {},
        {},
        set(),
        [],
    )

    assert len(ops) == 10
    assert not skipped

    assert [o[2].day for o in ops] == [
        1, 3, 5, 8, 28,
        1, 3, 5, 8, 29,
    ]

    grouped = {
        ("Inverter", 1): 3,
        ("Inverter", 2): 3,
    }

    ops, skipped = ed._plan_operations(
        [date(2026, 12, 1)],
        grouped,
        {},
        {},
        set(),
        [],
    )

    assert len(ops) == 2
    assert ops[0][2] == ops[1][2]
    assert ops[0][3] != ops[1][3]


@pytest.mark.parametrize(
    "state",
    [
        {"status": "Pending approval"},
        {"status": "Approved"},
        {"status": "Returned"},
        {"permission": "Granted"},
        {"checklist": [{"result": "OK"}]},
        {"remarks": "field work"},
        {"submitted_name": "Engineer"},
    ],
)
def test_protected_occurrence_skipped_without_blocking_other_changes(
    state,
):
    month = date(2026, 12, 1)

    a = row(**state)
    b = row("VCB", "VCB — plant visit")

    ops, skipped = ed._plan_operations(
        [month],
        {
            ("Inverter", 1): 3,
            ("VCB", None): 8,
        },
        {},
        {
            (month, ("Inverter", 1)): a,
            (month, ("VCB", None)): b,
        },
        set(),
        [],
    )

    assert len(ops) == len(skipped) == 1
    assert ops[0][1] is b
    assert skipped[0]["equipment"] == "Inverter 1"


def test_photo_protection_and_removal():
    month = date(2026, 12, 1)

    a = row("Earth pit", "Earth pit — plant visit")

    args = (
        [month],
        {("Earth pit", None): None},
        {},
        {(month, ("Earth pit", None)): a},
    )

    assert ed._plan_operations(
        *args,
        {str(a.id)},
        [],
    )[1]

    ops, refused = ed._plan_operations(
        *args,
        set(),
        [],
    )

    assert len(ops) == 1
    assert ops[0][2] is None
    assert not refused


def test_duplicate_and_mismatched_inverter_validation():
    p = ed.ScheduleRequest(
        month="2026-12",
        mode="create",
        changes=[
            {
                "equipment": "Inverter",
                "inverter_no": 1,
                "day": 1,
            },
            {
                "equipment": "Inverter",
                "inverter_no": 1,
                "day": 3,
            },
        ],
    )

    with pytest.raises(HTTPException, match="Duplicate"):
        ed._changes(p, 2)

    with pytest.raises(HTTPException, match="contiguous"):
        ed._validate_inverters(
            {
                ("Inverter", 1): 1,
                ("Inverter", 3): 3,
            },
            3,
        )


def test_scope_and_history_gap():
    selected = date(2027, 1, 1)
    december = date(2026, 12, 1)
    february = date(2027, 2, 1)

    p = ed.ScheduleRequest(
        month="2027-01",
        mode="edit",
        scope="future",
        changes=[
            {
                "equipment": "VCB",
                "day": 3,
            }
        ],
    )

    assert ed._target_months(
        p,
        selected,
        [december, selected, february],
        selected,
    ) == [selected, february]

    with pytest.raises(
        HTTPException,
        match="Historical month",
    ):
        ed._target_months(
            p,
            selected,
            [selected, february],
            selected,
        )

    p.scope = "month"

    assert ed._target_months(
        p,
        selected,
        [december, selected, february],
        selected,
    ) == [selected]


@pytest.mark.parametrize(
    "role,expected",
    [
        ("O&M Head", 503),
        ("Assignee", 503),
        ("Site Engineer", 403),
        ("Technician", 403),
    ],
)
def test_role_and_fail_closed_when_schema_missing(
    client,
    db,
    role,
    expected,
):
    login_user(
        client,
        db,
        role=role,
        email="ed-guard@example.com",
    )

    base = "/api/pm-plan/schedules"

    payload = {
        "month": "2026-12",
        "mode": "create",
        "scope": "future",
        "changes": [
            {
                "equipment": "Inverter",
                "inverter_no": 1,
                "day": 1,
            }
        ],
    }

    responses = [
        client.get(base),
        client.get(base + "/TEST01?month=2026-12"),
        client.post(
            base + "/TEST01/preview",
            json=payload,
        ),
        client.post(
            base + "/TEST01/save",
            json=payload,
        ),
    ]

    detail = (
        "Permanent PM recurrence SQL is not installed"
        if expected == 503
        else (
            "Only an O&M Head or Assignee may manage "
            "recurring PM schedules"
        )
    )

    for response in responses:
        assert response.status_code == expected, response.text
        assert response.json() == {"detail": detail}

    assert db.query(Plant).count() == 0
    assert db.query(PMTrackingActivity).count() == 0


def test_existing_rule_collision_preflight():
    r = {
        "equipment": "Inverter",
        "equipment_id": "INV 1",
        "day_no": 1,
        "inverter_no": 1,
    }

    with pytest.raises(HTTPException, match="collision"):
        ed._rule_map(
            [
                r,
                {
                    **r,
                    "equipment_id": "INV-01",
                },
            ]
        )


def test_assignee_schedule_authority_not_equipment_scoped():
    ed._schedule_manager(
        SimpleNamespace(role="Assignee")
    )

    ed._schedule_manager(
        SimpleNamespace(role="O&M Head")
    )

    with pytest.raises(HTTPException) as error:
        ed._schedule_manager(
            SimpleNamespace(role="Site Engineer")
        )

    assert error.value.status_code == 403