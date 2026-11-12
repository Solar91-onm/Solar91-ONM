"""The Design/MDL folder link is only sent to O&M Head, Assignee and Administration."""
from types import SimpleNamespace

import pytest

from app.core.security import can_view_design_link, visible_custom_fields
from app.portal.service import plant_out

FIELDS = {"design_link": "https://folder.example.invalid/ABH01", "design_index": {"ga": True}, "cctv_url": "x"}


def _user(role, active=True):
    return SimpleNamespace(role=role, is_active=active)


@pytest.mark.parametrize("role", ["O&M Head", "Assignee", "Administration"])
def test_allowed_roles_receive_the_link(role):
    assert can_view_design_link(_user(role))
    assert visible_custom_fields(FIELDS, _user(role)) == FIELDS


@pytest.mark.parametrize("role", ["Site Engineer", "Viewer", "Unknown"])
def test_other_roles_do_not_receive_the_link(role):
    out = visible_custom_fields(FIELDS, _user(role))
    assert "design_link" not in out
    assert out["design_index"] == {"ga": True} and out["cctv_url"] == "x"   # other keys untouched


def test_inactive_or_missing_user_does_not_receive_the_link():
    assert "design_link" not in visible_custom_fields(FIELDS, _user("O&M Head", active=False))
    assert "design_link" not in visible_custom_fields(FIELDS, None)


def test_redaction_never_mutates_the_stored_fields():
    stored = dict(FIELDS)
    visible_custom_fields(stored, _user("Site Engineer"))
    assert stored == FIELDS


def test_portal_plant_payload_is_redacted_per_role():
    plant = SimpleNamespace(
        id="p1", site_code="ABH01", plant_name="Abhaneri", project_company=None, district=None, discom=None,
        location=None, latitude=None, longitude=None, dc_capacity_kw=None, ac_capacity_kw=None,
        commissioned_on=None, status="active", assigned_engineer=None, custom_fields=dict(FIELDS),
    )
    assert "design_link" not in plant_out(plant, [], "", _user("Site Engineer"))["custom_fields"]
    assert plant_out(plant, [], "", _user("Assignee"))["custom_fields"]["design_link"] == FIELDS["design_link"]
    assert plant.custom_fields == FIELDS
