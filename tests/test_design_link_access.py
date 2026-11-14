"""The Design/MDL folder link is only sent to O&M Head, Assignee and Administration."""
from types import SimpleNamespace

import pytest

from app.core.security import can_view_design_link, visible_custom_fields
from app.portal.service import plant_out

FIELDS = {
    "design_link": "https://folder.example.invalid/ABH01",
    "design_index": {"ga": True},
    "cctv_url": "x",
    "security_guard": {"guard_name": "Asha", "mobile_no": "9876543210"},
    "security_contacts": {
        "site_engineers": [{"name": "Engineer A", "mobile_no": "9876543210", "shift": "day"}],
        "guards": [{"name": "Guard A", "mobile_no": "9876543210", "shift": "night"}],
    },
}


def _user(role, active=True):
    return SimpleNamespace(role=role, is_active=active)


@pytest.mark.parametrize("role", ["O&M Head", "Assignee", "Administration"])
def test_allowed_roles_receive_the_link(role):
    assert can_view_design_link(_user(role))
    fields = visible_custom_fields(FIELDS, _user(role))
    assert fields["design_link"] == FIELDS["design_link"]
    assert ("security_guard" in fields) == (role in {"O&M Head", "Administration"})
    assert ("security_contacts" in fields) == (role in {"O&M Head", "Administration"})


@pytest.mark.parametrize("role", ["Site Engineer", "Viewer", "Unknown"])
def test_other_roles_do_not_receive_the_link(role):
    out = visible_custom_fields(FIELDS, _user(role))
    assert "design_link" not in out
    assert "security_guard" not in out
    assert "security_contacts" not in out
    assert out["design_index"] == {"ga": True} and out["cctv_url"] == "x"   # other keys untouched


def test_inactive_or_missing_user_does_not_receive_the_link():
    assert "design_link" not in visible_custom_fields(FIELDS, _user("O&M Head", active=False))
    assert "design_link" not in visible_custom_fields(FIELDS, None)
    assert "security_contacts" not in visible_custom_fields(FIELDS, _user("O&M Head", active=False))
    assert "security_contacts" not in visible_custom_fields(FIELDS, None)


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
    restricted = plant_out(plant, [], "", _user("Site Engineer"))["custom_fields"]
    assert "design_link" not in restricted
    assert "security_guard" not in restricted
    assert "security_contacts" not in restricted
    assert plant_out(plant, [], "", _user("Assignee"))["custom_fields"]["design_link"] == FIELDS["design_link"]
    assert plant.custom_fields == FIELDS


@pytest.mark.parametrize("role", ["O&M Head", "Administration"])
def test_security_guard_details_are_visible_only_to_authorized_portfolio_roles(role):
    assert visible_custom_fields(FIELDS, _user(role))["security_guard"] == FIELDS["security_guard"]
    assert visible_custom_fields(FIELDS, _user(role))["security_contacts"] == FIELDS["security_contacts"]
