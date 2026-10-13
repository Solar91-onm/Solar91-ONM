from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import RedirectResponse

from app.core.config import get_settings
from app.core.models import User
from app.core.security import get_current_user

router = APIRouter(tags=["Authentication"])
settings = get_settings()


@router.get("/auth/login", include_in_schema=False)
def login_entry():
    # The browser renders sign-in for the active provider on the homepage.
    return RedirectResponse(url="/?signin=1", status_code=303)


@router.post("/auth/logout")
def logout_entry():
    return {"ok": True, "provider": "supabase"}


@router.get("/api/auth/config")
def auth_config():
    return {
        "provider": "supabase",
        "configured": settings.supabase_configured,
        "supabase_url": settings.supabase_url,
        "anon_key": settings.supabase_anon_key,
    }


@router.get("/api/auth/session")
def session_info(user: Annotated[User, Depends(get_current_user)]):
    return {
        "authenticated": True,
        "provider": "supabase",
        "user": {
            "id": str(user.id),
            "external_id": user.external_subject,
            "name": user.display_name,
            "email": user.email,
            "role": user.role,
        },
        "role_model": ["O&M Head", "Assignee", "Administration", "Site Engineer"],
    }
