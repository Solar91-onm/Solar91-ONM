from __future__ import annotations
import json
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from datetime import date
from sqlalchemy import select
from app.core.database import SessionLocal
from app.core.models import AppSetting, NotificationRule, Plant

plants=json.loads((ROOT/"scripts"/"legacy_plants.json").read_text(encoding="utf-8"))
rules=[
 {"id":"RUL-CRITICAL","event":"Critical issue created","channel":"Call + SMS + app + email","to":"O&M Head, assignee","tiers":"Immediate","on":True},
 {"id":"RUL-ETC","event":"Issue nearing ETC (Critical)","channel":"App + email","to":"Assignee, O&M Head","tiers":"At 75% of ETC","on":True},
 {"id":"RUL-SLA","event":"SLA breach (past ETC)","channel":"App + email + SMS","to":"O&M Head, management","tiers":"Breach, then daily","on":True},
 {"id":"RUL-TASK","event":"Scheduled task overdue","channel":"App","to":"Assignee","tiers":"1d reminder → 3d supervisor → 7d O&M Head","on":True},
 {"id":"RUL-WASH","event":"Washing compliance below threshold","channel":"Email","to":"Washing supervisor","tiers":"Weekly check","on":True},
 {"id":"RUL-SPARES","event":"Spares low stock","channel":"App + email","to":"Stores, O&M Head","tiers":"On crossing min","on":True},
 {"id":"RUL-DOC","event":"Document expiry approaching","channel":"App + email","to":"Document owner","tiers":"30d / 14d / 7d / on expiry","on":True},
 {"id":"RUL-ANOMALY","event":"Task anomaly flagged on completion","channel":"App + email","to":"O&M Head","tiers":"Immediate","on":False},
]

def main():
    db=SessionLocal()
    try:
        for x in plants:
            row=db.scalar(select(Plant).where(Plant.site_code==x["siteCode"]))
            if not row:
                row=Plant(site_code=x["siteCode"],plant_name=str(x.get("plantName") or x["siteCode"]).strip(),source="legacy-seed")
            row.project_company=x.get("projectCompany"); row.commissioned_on=date.fromisoformat(x["commissionedOn"]) if x.get("commissionedOn") else None; row.dc_capacity_kw=x.get("capacitykW"); row.ac_capacity_kw=x.get("acCapacitykW"); row.legacy_payload={"id":x["siteCode"],"name":x.get("plantName"),"capacity":x.get("capacitymW"),"project":x.get("projectCompany"),"source":"excel"}
            db.add(row)
        for r in rules:
            row=db.scalar(select(NotificationRule).where(NotificationRule.legacy_id==r["id"]))
            if not row: row=NotificationRule(legacy_id=r["id"],event_name=r["event"])
            row.event_name=r["event"];row.channel=r["channel"];row.recipients=r["to"];row.tiers=r["tiers"];row.enabled=r["on"];row.payload=r;db.add(row)
        for k,v in {"view":"dashboard","omTab":"handover","extSub":"requests","opsDate":date.today().isoformat(),"customPlantColumns":[],"plantCustomValues":{},"plantEnrich":{},"_seq":1000}.items():
            row=db.get(AppSetting,k) or AppSetting(setting_key=k,setting_value=v);row.setting_value=v;db.add(row)
        db.commit();print(f"Seeded/updated {len(plants)} plants and {len(rules)} notification rules.")
    finally: db.close()

if __name__=="__main__": main()
