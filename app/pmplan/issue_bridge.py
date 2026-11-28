"""Create corrective Site Issues from a submitted PM checklist's Not OK items.

Nothing is created on submission. The plant's PM Assignee (or an O&M Head) reviews
the record and raises the items they choose, in one transaction. The existing
Issue.source_task column and deterministic primary keys provide a stable link
without a schema migration. No calls to IssueService.create (which commits
independently) and no network calls inside this transaction.
"""
from datetime import datetime, time, timedelta, timezone
from uuid import UUID, uuid5

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.models import Issue, Plant, User, WorkCategory
from app.equipment.issue_routing import IssueRouting
from app.equipment.service import canonical_key
from app.issues.deadlines import default_deadline
from app.issues.service import IssueService, next_issue_ticket_no
from app.notifications.service import notify_users, users_with_role

_NAMESPACE = UUID('7ff8a2bb-465a-4c52-934f-fbbaef95cc06')
# "Abnormality" is no longer offered, but older submissions that used it stay raisable.
FAULT_RESULTS = {'Not OK', 'Abnormality'}


def findings(row) -> list[dict]:
    """The checklist items a site issue can be raised for."""
    return [c for c in (row.checklist or []) if isinstance(c, dict) and c.get('id') and c.get('result') in FAULT_RESULTS]


def raised_tickets(db: Session, rows) -> dict[str, dict[str, str]]:
    """{activity id: {checklist item id: ticket no}} for findings already raised, in bounded queries."""
    keys = {uuid5(_NAMESPACE, f"{row.id}:{c['id']}"): (str(row.id), c['id']) for row in rows for c in findings(row)}
    out: dict[str, dict[str, str]] = {}
    ids = list(keys)
    for start in range(0, len(ids), 500):
        for issue_id, ticket in db.execute(select(Issue.id, Issue.ticket_no).where(Issue.id.in_(ids[start:start + 500]))):
            activity, item = keys[issue_id]
            out.setdefault(activity, {})[item] = ticket
    return out


def _equipment(activity_equipment: str, task: str) -> str:
    # Explicit section labels from the PM templates, not keyword guessing from
    # free-text observations. GSS sections share the existing GSS responsibility.
    if activity_equipment == '4 Pole + ACDB + Aux. TX':
        return {'Four Pole': '4 Pole', 'ACDB': 'ACDB',
                'Auxiliary Transformer': 'Aux. Transformer'}.get(task.split(' — ', 1)[0], activity_equipment)
    if activity_equipment == 'GSS visit':
        return {'GSS-side VCB & Kiosk': 'VCB - GSS side',
                'GSS-side Switchyard': 'Switchyard'}.get(task.split(' — ', 1)[0], activity_equipment)
    if activity_equipment == 'Miscellaneous':
        return {'Water pipe line and motor': 'Water Pipeline and Motor',
                'Comminication system check': 'Communication System',
                'WMS calibration checked': 'Weather Monitoring System'}.get(task.split('- ', 1)[0], activity_equipment)
    return activity_equipment


def create_corrective_issues(db: Session, row, plant: Plant, actor: User, now: datetime,
                             item_ids: set[str] | None = None) -> list[dict]:
    """Called after validation, with the ticket-number and PM plant locks held.

    One ticket per failed checkpoint per activity (even if returned/resubmitted
    or archived). A repeat never silently reopens or overwrites a corrective ticket.
    ``item_ids`` limits the batch to the findings the reviewer chose.
    """
    faults = [c for c in findings(row) if item_ids is None or c['id'] in item_ids]
    if not faults:
        return []
    items = [(uuid5(_NAMESPACE, f"{row.id}:{c['id']}"), c) for c in faults]
    existing = dict(db.execute(select(Issue.id, Issue.ticket_no).where(
        Issue.id.in_([i for i, _ in items]))).all())
    new_items = [(i, c) for i, c in items if i not in existing]
    if not new_items:
        return [{'ticket_no': existing[i], 'created': False} for i, _ in items]

    # One catalogue, routing and deadline lookup for the batch. Use the actual
    # active master name where possible (e.g. VCB Panel rather than VCB).
    names = list(db.scalars(select(WorkCategory.name).where(WorkCategory.active.is_(True)).order_by(WorkCategory.name)))
    def category(task):
        label = _equipment(row.equipment, task)
        exact = next((n for n in names if n.casefold() == label.casefold()), None)
        if exact or row.equipment == 'GSS visit':
            return exact or label
        return next((n for n in names if canonical_key(n) == canonical_key(label)), label)
    categories = {i: category(c['task']) for i, c in new_items}
    routing = IssueRouting(db, {canonical_key(n) for n in categories.values() if canonical_key(n)}, {row.plant_id})
    due = default_deadline(db, 'Medium', start=now)
    heads = users_with_role(db, {'O&M Head'})
    next_no = int(next_issue_ticket_no(db).split('-', 1)[1])
    history = IssueService(db)
    created = {}
    for issue_id, c in new_items:
        equipment = categories[issue_id]
        owner, rule = routing.resolve(row.plant_id, equipment)
        source = f"PM:{row.id}:{c['id']}"
        description = (f"Preventive Maintenance · {row.equipment_id} · {row.inspected_on.isoformat()}\n"
                       f"Checkpoint: {c['task']}\nResult: {c['result']}\nObservation: {c['note']}"
                       + (f"\nFound by: {row.submitted_name}" if row.submitted_name else ""))
        readings = c.get("measurements") or []
        if readings:
            description += "\nMeasurements: " + "; ".join(
                f"{m['context'] + ': ' if m.get('context') else ''}{m['value']} {m['unit']}" for m in readings)
        occurred = min(now, datetime.combine(row.inspected_on, time(9),
                        tzinfo=timezone(timedelta(hours=5, minutes=30))).astimezone(timezone.utc))
        issue = Issue(id=issue_id, ticket_no=f'ISS-{next_no:04d}', plant_id=row.plant_id,
                      vertical=equipment, subcategory=f"PM checklist: {c['result']}",
                      serial_no=row.equipment_id, description=description, severity='Medium',
                      equipment_running=None, status='Assigned' if owner else 'Open',
                      assigned_to=owner.id if owner else None,
                      assignee_text=owner.display_name if owner else None, created_by=actor.id,
                      occurred_at=occurred, etc_at=due, source_task=source,
                      legacy_payload={'evidence': [], 'pm_source': {'activity_id': str(row.id),
                          'checklist_item_id': c['id'], 'task': c['task'], 'result': c['result'],
                          'observation': c['note'], 'equipment_id': row.equipment_id,
                          'submitted_by': str(row.submitted_by) if row.submitted_by else None,
                          'submitted_name': row.submitted_name,
                          **({'measurements': readings} if readings else {}),
                          'scheduled_on': row.scheduled_on.isoformat(), 'inspected_on': row.inspected_on.isoformat()}})
        next_no += 1
        db.add(issue)
        created[issue_id] = (issue, owner, rule, c)
    # Flush the batch before history rows reference their foreign keys.
    db.flush()
    for issue, owner, rule, c in created.values():
        history._history(issue, 'issue.created', actor, status_to=issue.status,
                         note=f'Raised from a Preventive Maintenance checklist by {actor.display_name}',
                         metadata={'source_task': issue.source_task, 'pm_activity_id': str(row.id),
                                   'checklist_item_id': c['id'], 'result': c['result']})
        history._history(issue, 'issue.auto_assigned' if owner else 'issue.assignment_skipped', actor,
                         status_to=issue.status, note=(f'Assigned automatically to {owner.display_name} ({rule})'
                             if owner else 'No eligible Site Issue Assignee configured; O&M Head action required.'),
                         metadata={'rule': rule, 'assigned_to': str(owner.id) if owner else None})
        notify_users(db, [*heads, *([owner] if owner else [])],
                     event_type='ticket_assigned' if owner else 'issue_unassigned',
                     title=('PM issue assigned — ' if owner else 'PM issue needs assignment — ') + issue.ticket_no,
                     message=f"{plant.site_code} · {issue.vertical} · {row.equipment_id} · {c['task']} · {c['note'][:180]}",
                     target_type='issue', target_id=issue.ticket_no,
                     dedupe_key=f'pm-corrective:{issue.id}')
    return [{'ticket_no': created[i][0].ticket_no, 'created': True} if i in created else
            {'ticket_no': existing[i], 'created': False} for i, _ in items]
