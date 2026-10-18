from tests.conftest import login_user
from app.main import app
import pytest

@pytest.mark.parametrize("role", ["O&M Head","Site Engineer","Assignee","Technician"])
def test_get_sweep(client, db, role):
    login_user(client, db, role=role, email=f"sweep-{role[:3].lower()}@example.com")
    bad=[]
    for r in app.routes:
        p=getattr(r,'path','')
        if 'GET' in (getattr(r,'methods',None) or []) and p.startswith('/api') and '{' not in p:
            resp=client.get(p)
            if resp.status_code>=500: bad.append((p,resp.status_code,resp.text[:200]))
    assert not bad, bad
