"""Site-issue-only responsibility overrides in existing app_settings.

Every write and issue creation uses the existing ticket advisory transaction lock.
No process cache for assignment decisions; PM responsibility remains independent.
"""
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.core.models import AppSetting, EquipmentResponsibility, User
from app.equipment.service import canonical_key

SETTING_KEY = "site_issue_routing_v1"
ALL = "*"
MAX_RULES = 2000


def read_rules(db: Session) -> dict:
    row = db.get(AppSetting, SETTING_KEY, populate_existing=True)
    if row is None or not isinstance(row.setting_value, dict):
        return {}
    return {key: value for key, value in row.setting_value.items() if isinstance(value, dict)}


def rule_key(plant_id, equipment_key: str) -> str:
    return f"{plant_id or ALL}:{equipment_key}"


class IssueRouting:
    """One fresh rule and eligible-owner snapshot, reusable during bulk routing."""
    def __init__(self, db: Session, equipment_keys: set[str] | None = None,
                 plant_ids: set[UUID] | None = None):
        if plant_ids is not None and len(plant_ids) == 1 and equipment_keys is not None and len(equipment_keys) <= 1:
            # Ticket creation reads only its relevant override/default JSON entries, not the
            # entire portfolio rule document. Works with PostgreSQL JSONB and SQLite JSON.
            pid = next(iter(plant_ids))
            identities = list(dict.fromkeys([*(rule_key(pid, key) for key in equipment_keys),
                                             rule_key(pid, ALL), rule_key(None, ALL)]))
            values = db.execute(select(*(AppSetting.setting_value[key].as_json() for key in identities))
                                .where(AppSetting.setting_key == SETTING_KEY)).first()
            self.rules = {key: value for key, value in zip(identities, values or ()) if isinstance(value, dict)}
        else:
            self.rules = read_rules(db)
        if plant_ids is not None:
            scopes = {str(pid) for pid in plant_ids} | {ALL}
            self.rules = {key: value for key, value in self.rules.items()
                          if key.split(":", 1)[0] in scopes}
        ids = set()
        for rule in self.rules.values():
            for field in ("primary_user_id", "backup_user_id"):
                try:
                    if rule.get(field):
                        ids.add(UUID(rule[field]))
                except (TypeError, ValueError, AttributeError):
                    continue
        # Fetch global owners and scoped rule users in one query. Only the selected
        # equipment joins to responsibility rows; a scoped owner need not hold one.
        conditions = [User.id == EquipmentResponsibility.user_id,
                      EquipmentResponsibility.active.is_(True)]
        if equipment_keys is not None:
            conditions.append(EquipmentResponsibility.equipment_key.in_(equipment_keys))
        query = select(EquipmentResponsibility.equipment_key,
                       EquipmentResponsibility.position, User).select_from(User).join(
            EquipmentResponsibility, and_(*conditions), isouter=bool(ids)).where(
            User.is_active.is_(True), User.role == "Assignee").order_by(User.id)
        if ids:
            query = query.where(or_(EquipmentResponsibility.user_id.is_not(None), User.id.in_(ids)))
        self.global_owners = {}
        self.people = {}
        for key, position, user in db.execute(query):
            if key is not None:
                self.global_owners.setdefault(key, {}).setdefault(position, user)
            if user.id in ids:
                self.people[str(user.id)] = user

    def resolve(self, plant_id, equipment: str | None) -> tuple[User | None, str | None]:
        key = canonical_key(equipment)
        if not plant_id:
            return None, None
        scopes = [(rule_key(plant_id, key), "plant_equipment")] if key else []
        scopes.append((rule_key(plant_id, ALL), "plant_all"))
        for identity, source in scopes:
            rule = self.rules.get(identity, {})
            for position in ("primary", "backup"):
                user = self.people.get(str(rule.get(position + "_user_id")))
                if user:
                    return user, source + "_" + position
        for position in ("primary", "backup"):
            user = self.global_owners.get(key, {}).get(position)
            if user:
                return user, "equipment_" + position
        rule = self.rules.get(rule_key(None, ALL), {})
        for position in ("primary", "backup"):
            user = self.people.get(str(rule.get(position + "_user_id")))
            if user:
                return user, "default_" + position
        return None, None
