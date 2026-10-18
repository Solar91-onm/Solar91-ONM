from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.timeutil import business_now
from app.core.models import (
    Notification,
    NotificationPreference,
    OMTask,
    PMAlertLog,
    PMFollowUp,
    Plant,
    User,
    UserPlantAssignment,
)
from app.notifications.mailer import send_pm_alert_email
from app.notifications.service import notify_users

PM_ALERT_EVENTS: dict[str, dict[str, Any]] = {
    "pm_due_soon": {"enabled": True, "in_app": True, "email": False},
    "pm_due_today": {"enabled": True, "in_app": True, "email": False},
    "pm_late_1d": {"enabled": True, "in_app": True, "email": False},
    "pm_late_3d": {"enabled": True, "in_app": True, "email": False},
    "pm_critical_7d": {"enabled": True, "in_app": True, "email": False},
    "pm_promise_missed": {"enabled": True, "in_app": True, "email": False},
    "pm_no_followup": {"enabled": True, "in_app": True, "email": False},
    "pm_weekly_summary": {"enabled": False, "in_app": True, "email": False},
    "pm_daily_plan": {"enabled": True, "in_app": True, "email": False},
}
DAILY_PLAN_HOUR = 6          # the morning digest goes out from 06:00 plant time
PM_TEAM_RECIPIENT_MODES = {"assignee_only", "assignee_and_head", "whole_team"}
PM_SITE_ENGINEER_EVENTS = {
    "pm_due_soon", "pm_due_today", "pm_late_1d", "pm_late_3d", "pm_critical_7d",
}


def default_pm_preferences() -> dict[str, Any]:
    return {
        "events": {key: dict(value) for key, value in PM_ALERT_EVENTS.items()},
        "team_who": None,
    }


def _merge_preferences(target: dict[str, Any], saved: dict[str, Any]) -> None:
    events = saved.get("events")
    if isinstance(events, dict):
        for event, choices in events.items():
            if event in PM_ALERT_EVENTS and isinstance(choices, dict):
                target["events"][event].update({
                    key: bool(choices[key])
                    for key in ("enabled", "in_app", "email")
                    if key in choices
                })
    if saved.get("team_who") in PM_TEAM_RECIPIENT_MODES:
        target["team_who"] = saved["team_who"]


def get_pm_preferences(db: Session, user_id: UUID, plant_id: UUID | None) -> dict[str, Any]:
    preferences = default_pm_preferences()
    rows = list(db.scalars(
        select(NotificationPreference).where(
            NotificationPreference.user_id == user_id,
            NotificationPreference.module == "pm",
            NotificationPreference.plant_id.is_(None)
            if plant_id is None else
            NotificationPreference.plant_id.in_([plant_id]) | NotificationPreference.plant_id.is_(None),
        ).order_by(NotificationPreference.plant_id.is_not(None))
    ))
    for row in rows:
        _merge_preferences(preferences, row.preferences or {})
    return preferences


def _team_recipient_mode(
    db: Session,
    plant_id: UUID | None,
    cache: dict[UUID | None, str | None],
) -> str | None:
    if plant_id in cache:
        return cache[plant_id]
    rows = list(db.scalars(
        select(NotificationPreference)
        .join(User, User.id == NotificationPreference.user_id)
        .where(
            User.role == "O&M Head",
            User.is_active.is_(True),
            NotificationPreference.module == "pm",
            NotificationPreference.plant_id.is_(None)
            if plant_id is None else
            NotificationPreference.plant_id.in_([plant_id]) | NotificationPreference.plant_id.is_(None),
        )
        .order_by(NotificationPreference.updated_at.desc())
    ))
    specific = next((
        (row.preferences or {}).get("team_who")
        for row in rows
        if row.plant_id == plant_id and (row.preferences or {}).get("team_who") in PM_TEAM_RECIPIENT_MODES
    ), None)
    global_mode = next((
        (row.preferences or {}).get("team_who")
        for row in rows
        if row.plant_id is None and (row.preferences or {}).get("team_who") in PM_TEAM_RECIPIENT_MODES
    ), None)
    mode = specific or global_mode
    cache[plant_id] = mode
    return mode


def _users_for_plant(db: Session, plant_id: UUID, roles: set[str]) -> list[User]:
    return list(db.scalars(
        select(User)
        .join(UserPlantAssignment, UserPlantAssignment.user_id == User.id)
        .where(
            UserPlantAssignment.plant_id == plant_id,
            User.role.in_(roles),
            User.is_active.is_(True),
        )
    ))


def _recipients(db: Session, tasks: list[OMTask], roles: set[str]) -> list[User]:
    users: dict[UUID, User] = {}
    for task in tasks:
        if "Assignee" in roles and task.assignee_user_id:
            user = db.get(User, task.assignee_user_id)
            if user and user.is_active and user.role == "Assignee":
                users[user.id] = user
        if task.plant_id and "Site Engineer" in roles:
            for user in _users_for_plant(db, task.plant_id, {"Site Engineer"}):
                users[user.id] = user
    role_names = roles - {"Assignee", "Site Engineer"}
    if role_names:
        for user in db.scalars(select(User).where(User.role.in_(role_names), User.is_active.is_(True))):
            users[user.id] = user
    return list(users.values())


def _effective_recipients(
    db: Session,
    tasks: list[OMTask],
    default_roles: set[str],
    mode_cache: dict[UUID | None, str | None],
    event: str,
) -> list[User]:
    plant_id = tasks[0].plant_id if tasks else None
    mode = _team_recipient_mode(db, plant_id, mode_cache)
    if mode == "assignee_only":
        roles = {"Assignee"}
    elif mode == "assignee_and_head":
        roles = {"Assignee", "O&M Head"}
    elif mode == "whole_team":
        roles = {"Assignee", "O&M Head", "Site Engineer"}
    else:
        roles = default_roles
    users = _recipients(db, tasks, roles)
    if event in PM_SITE_ENGINEER_EVENTS:
        users.extend(_recipients(db, tasks, {"Site Engineer"}))
    return list({user.id: user for user in users}.values())


def _deliveries(
    db: Session,
    users: list[User],
    event: str,
    plant_id: UUID | None,
    cache: dict[tuple[UUID, UUID | None], dict[str, Any]],
) -> tuple[list[User], list[User]]:
    in_app: list[User] = []
    email: list[User] = []
    for user in users:
        key = (user.id, plant_id)
        settings = cache.get(key)
        if settings is None:
            settings = cache[key] = get_pm_preferences(db, user.id, plant_id)
        choice = settings["events"].get(event, PM_ALERT_EVENTS[event])
        if not choice["enabled"]:
            continue
        if choice["in_app"]:
            in_app.append(user)
        if choice["email"] and user.email:
            email.append(user)
    return in_app, email


def _reserve_alert(
    db: Session,
    *,
    task: OMTask,
    level: str,
    due_on: date | None,
    key: str,
    recipients_text: str,
) -> bool:
    values = {
        "id": None,
        "task_id": task.id,
        "level": level,
        "due_on": due_on,
        "recipients_text": recipients_text,
        "dedupe_key": key,
    }
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    elif dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:
        if db.scalar(select(PMAlertLog.id).where(PMAlertLog.dedupe_key == key)):
            return False
        db.add(PMAlertLog(
            task_id=task.id, level=level, due_on=due_on,
            recipients_text=recipients_text, dedupe_key=key,
        ))
        return True
    values.pop("id")
    statement = insert(PMAlertLog).values(**values).on_conflict_do_nothing(
        index_elements=[PMAlertLog.dedupe_key]
    )
    return bool(db.execute(statement).rowcount)


def emit_pm_alert(
    db: Session,
    *,
    task: OMTask,
    tasks: list[OMTask],
    event: str,
    level: str,
    due_on: date | None,
    key: str,
    title: str,
    message: str,
    default_roles: set[str],
    target_id: str | None = None,
    mode_cache: dict[UUID | None, str | None] | None = None,
    preference_cache: dict[tuple[UUID, UUID | None], dict[str, Any]] | None = None,
) -> bool:
    mode_cache = mode_cache if mode_cache is not None else {}
    preference_cache = preference_cache if preference_cache is not None else {}
    users = _effective_recipients(db, tasks, default_roles, mode_cache, event)
    in_app, email = _deliveries(db, users, event, task.plant_id, preference_cache)
    if not in_app and not email:
        return False
    recipients = {user.id: user for user in [*in_app, *email]}
    names = ", ".join(sorted({user.display_name for user in recipients.values()}))
    if not _reserve_alert(
        db, task=task, level=level, due_on=due_on, key=key, recipients_text=names,
    ):
        return False
    if in_app:
        notify_users(
            db, in_app, event_type=event, title=title, message=message,
            target_type="task", target_id=target_id or task.work_order_no,
            dedupe_key=key,
        )
    email_sent = False
    for user in email:
        sent, _reason = send_pm_alert_email(
            to_email=user.email or "",
            name=user.display_name,
            title=title,
            message=message,
            work_order_no=target_id or task.work_order_no,
        )
        email_sent = email_sent or sent
    if not in_app and not email_sent:
        reserved = db.scalar(select(PMAlertLog).where(PMAlertLog.dedupe_key == key))
        if reserved:
            db.delete(reserved)
            db.flush()
        return False
    return True


def latest_group_follow_up(db: Session, tasks: list[OMTask]) -> PMFollowUp | None:
    if not tasks:
        return None
    return db.scalar(
        select(PMFollowUp)
        .where(PMFollowUp.task_id.in_([task.id for task in tasks]))
        .order_by(PMFollowUp.at.desc(), PMFollowUp.id.desc())
        .limit(1)
    )


def task_alert_scope(db: Session, task: OMTask) -> list[OMTask]:
    """Return the PM job rows represented by a task, including legacy unit groups."""
    if not task.unit_no or not task.cycle_id:
        return [task]
    return list(db.scalars(select(OMTask).where(
        OMTask.plant_id == task.plant_id,
        func.lower(OMTask.task_type) == (task.task_type or "").casefold(),
        OMTask.cycle_id == task.cycle_id,
        OMTask.status.in_({"Scheduled", "In Progress"}),
    ).order_by(OMTask.unit_no)))


def send_pm_alerts(db: Session, today: date, now: datetime | None = None) -> dict[str, int]:
    from app.pmplan.units import OPEN_STATUSES, _alert_groups

    result = {
        "advance": 0, "due_today": 0, "escalated": 0,
        "promise_missed": 0, "no_followup": 0, "weekly_summary": 0, "daily_plan": 0,
    }
    open_tasks = list(db.scalars(select(OMTask).where(
        OMTask.status.in_(OPEN_STATUSES), OMTask.due_on.is_not(None),
    )))
    mode_cache: dict[UUID | None, str | None] = {}
    preference_cache: dict[tuple[UUID, UUID | None], dict[str, Any]] = {}
    groups = _alert_groups(open_tasks)

    for task, members, due_on, group_key in groups:
        if not due_on:
            continue
        plant = db.get(Plant, task.plant_id) if task.plant_id else None
        label = task.task_name + (f" · {plant.plant_name}" if plant else "")
        if len(members) > 1:
            label += f" · {len(members)} legacy unit jobs"
        due_identity = due_on.isoformat()

        if task.status == "Scheduled" and due_on == today + timedelta(days=3):
            if emit_pm_alert(
                db, task=task, tasks=members, event="pm_due_soon", level="due_soon",
                due_on=due_on, key=f"pm-esc:{group_key}:{due_identity}:due_soon",
                title="PM due in 3 days", message=label, default_roles={"Assignee"},
                mode_cache=mode_cache, preference_cache=preference_cache,
            ):
                result["advance"] += 1
        if task.status == "Scheduled" and due_on == today:
            if emit_pm_alert(
                db, task=task, tasks=members, event="pm_due_today", level="due_today",
                due_on=due_on, key=f"pm-esc:{group_key}:{due_identity}:due_today",
                title="PM due today", message=label, default_roles={"Assignee"},
                mode_cache=mode_cache, preference_cache=preference_cache,
            ):
                result["due_today"] += 1

        late_days = (today - due_on).days
        tiers = (
            (7, "pm_critical_7d", "critical_7d", {"Assignee", "O&M Head"}, "PM critical — 7 days late"),
            (3, "pm_late_3d", "late_3d", {"Assignee", "O&M Head", "Site Engineer"}, "PM overdue 3 days — site call required"),
            (1, "pm_late_1d", "late_1d", {"Assignee", "O&M Head"}, "PM overdue 1 day"),
        )
        for days, event, level, roles, title in tiers:
            if late_days >= days:
                if emit_pm_alert(
                    db, task=task, tasks=members, event=event, level=level, due_on=due_on,
                    key=f"pm-esc:{group_key}:{due_identity}:{level}",
                    title=title, message=label, default_roles=roles,
                    mode_cache=mode_cache, preference_cache=preference_cache,
                ):
                    result["escalated"] += 1

        if late_days < 1:
            continue
        latest = latest_group_follow_up(db, members)
        promised_on = latest.promised_on if latest else None
        if promised_on and promised_on > today:
            continue
        baseline = max(
            [day for day in (due_on, latest.at.date() if latest else None, promised_on) if day],
        )
        without_contact_days = (today - baseline).days
        if without_contact_days >= 2:
            window = without_contact_days // 2
            if emit_pm_alert(
                db, task=task, tasks=members, event="pm_no_followup", level="no_followup",
                due_on=due_on,
                key=f"pm-no-followup:{group_key}:{due_identity}:{baseline.isoformat()}:{window}",
                title="PM follow-up needed", message=label,
                default_roles={"Assignee"}, mode_cache=mode_cache,
                preference_cache=preference_cache,
            ):
                result["no_followup"] += 1

    for followup in db.scalars(select(PMFollowUp).where(
        PMFollowUp.promised_on.is_not(None),
        PMFollowUp.promised_on < today,
    )):
        task = db.get(OMTask, followup.task_id)
        if not task or task.status not in OPEN_STATUSES:
            continue
        members = task_alert_scope(db, task)
        anchor, members, due_on, group_key = _alert_groups(members)[0]
        if emit_pm_alert(
            db, task=anchor, tasks=members, event="pm_promise_missed",
            level="promise_missed", due_on=due_on,
            key=f"pm-promise-missed:{group_key}:{followup.id}",
            title="PM promised date missed",
            message=f"{anchor.task_name} · promised {followup.promised_on.isoformat()}",
            default_roles={"Assignee", "O&M Head"},
            mode_cache=mode_cache, preference_cache=preference_cache,
        ):
            result["promise_missed"] += 1

    now = now or business_now()
    if now.weekday() == 0 and now.hour >= 8:
        late_groups = [(task, members, due, key) for task, members, due, key in groups if due and due < today]
        week = (today - timedelta(days=today.weekday())).isoformat()
        heads = _recipients(db, [task for task, *_ in late_groups], {"O&M Head"}) if late_groups else []
        if heads and late_groups and emit_pm_alert(
            db, task=late_groups[0][0], tasks=[task for task, *_ in late_groups],
            event="pm_weekly_summary", level="weekly_summary", due_on=today,
            key=f"pm-weekly-summary:{week}",
            title="Weekly PM overdue summary",
            message=f"{len(late_groups)} PM jobs remain overdue.",
            default_roles={"O&M Head"}, target_id=None,
            mode_cache=mode_cache, preference_cache=preference_cache,
        ):
            result["weekly_summary"] += 1
    result["daily_plan"] = send_pm_daily_plan(db, today, now)
    return result


def _on_day(task: OMTask, day: date) -> bool:
    """A PM job is on a day's plan from its planned start to its due date (one day for unit jobs)."""
    due = task.due_on
    if due is None:
        return False
    start = task.start_on if task.start_on and task.start_on <= due else due
    return start <= day <= due


def _units(task: OMTask) -> int:
    return 1 if task.unit_no else max(1, int(task.quantity or 1))


def daily_plan_text(tasks: list[OMTask], plants: dict[UUID, Plant]) -> tuple[str, str]:
    """('Today's PM plan · 2 plants · 6 units', 'Khorandi: Inverter ×4, WMS ×1 · Bhadla North: Transformer ×1')."""
    by_plant: dict[str, dict[str, int]] = {}
    for task in tasks:
        plant = plants.get(task.plant_id) if task.plant_id else None
        name = plant.plant_name if plant else "Unassigned plant"
        kinds = by_plant.setdefault(name, {})
        kind = task.task_type or "Equipment"
        kinds[kind] = kinds.get(kind, 0) + _units(task)
    total = sum(sum(kinds.values()) for kinds in by_plant.values())
    title = f"Today's PM plan · {len(by_plant)} plant{'s' if len(by_plant) != 1 else ''} · {total} unit{'s' if total != 1 else ''}"
    parts = [name + ": " + ", ".join(f"{kind} ×{n}" for kind, n in sorted(kinds.items(), key=lambda kv: (-kv[1], kv[0])))
             for name, kinds in sorted(by_plant.items(), key=lambda kv: (-sum(kv[1].values()), kv[0]))]
    message = " · ".join(parts)
    if len(message) > 480:
        message = message[:470].rsplit(" · ", 1)[0] + " · …"
    return title, message


def send_pm_daily_plan(db: Session, today: date, now: datetime | None = None) -> int:
    """One morning message per person: which plants and equipment are on today's PM plan.

    Assignees get their own jobs, Site Engineers the jobs at their plants, the O&M Head the whole portfolio.
    Each person can switch it off (or add email) under PM alerts. Deduplicated per person per day."""
    now = now or business_now()
    if now.hour < DAILY_PLAN_HOUR:
        return 0
    todays = [task for task in db.scalars(select(OMTask).where(
        OMTask.status.in_({"Scheduled", "In Progress"}), OMTask.due_on.is_not(None), OMTask.due_on >= today,
    )) if _on_day(task, today)]
    if not todays:
        return 0
    plants = {plant.id: plant for plant in db.scalars(select(Plant).where(Plant.id.in_({t.plant_id for t in todays if t.plant_id})))}
    by_user: dict[UUID, tuple[User, list[OMTask]]] = {}

    def add(user: User | None, tasks: list[OMTask]) -> None:
        if user is None or not user.is_active or not tasks:
            return
        _, current = by_user.setdefault(user.id, (user, []))
        seen = {t.id for t in current}
        current.extend(t for t in tasks if t.id not in seen)

    heads = list(db.scalars(select(User).where(User.role == "O&M Head", User.is_active.is_(True))))
    mode_cache: dict[UUID | None, str | None] = {}
    for_heads = [t for t in todays if _team_recipient_mode(db, t.plant_id, mode_cache) != "assignee_only"]
    for user in heads:
        add(user, for_heads)
    for task in todays:
        if task.assignee_user_id:
            assignee = db.get(User, task.assignee_user_id)
            if assignee and assignee.role == "Assignee":
                add(assignee, [task])
    for plant_id in {t.plant_id for t in todays if t.plant_id}:
        for engineer in _users_for_plant(db, plant_id, {"Site Engineer"}):
            add(engineer, [t for t in todays if t.plant_id == plant_id])

    cache: dict[tuple[UUID, UUID | None], dict[str, Any]] = {}
    sent = 0
    for user, tasks in by_user.values():
        in_app, email = _deliveries(db, [user], "pm_daily_plan", None, cache)
        if not in_app and not email:
            continue
        key = f"pm-daily-plan:{today.isoformat()}"
        already = db.scalar(select(func.count()).select_from(Notification).where(
            Notification.user_id == user.id, Notification.dedupe_key == f"{key}:{user.id}"))
        if already:
            continue
        title, message = daily_plan_text(tasks, plants)
        notify_users(db, [user], event_type="pm_daily_plan", title=title, message=message,
                     target_type="pm_day", target_id=today.isoformat(), dedupe_key=key)
        db.flush()
        for receiver in email:
            send_pm_alert_email(to_email=receiver.email or "", name=receiver.display_name, title=title,
                                message=message, work_order_no=tasks[0].work_order_no)
        sent += 1
    return sent


def alert_log_out(row: PMAlertLog) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "level": row.level,
        "due_on": row.due_on.isoformat() if row.due_on else None,
        "sent_at": row.sent_at.isoformat() if row.sent_at else None,
        "recipients_text": row.recipients_text,
    }
