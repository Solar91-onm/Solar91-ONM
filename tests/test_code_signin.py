from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUTH = (ROOT / "frontend/static/js/00-auth-data-and-imports.js").read_text(encoding="utf8")


def test_password_signin_is_still_present():
    assert 'id="supabase-password" name="password" type="password" autocomplete="current-password"' in AUTH
    assert "signInWithPassword" in AUTH


def test_email_code_signin_uses_supabase_otp_flow():
    assert 'id="supabase-code-link"' in AUTH
    assert "auth.signInWithOtp" in AUTH
    assert 'type:"email"' in AUTH and "auth.verifyOtp" in AUTH
    assert 'autocomplete="one-time-code"' in AUTH
    assert "S91_CODE_SIGNIN_CREATES_USERS" in AUTH


def test_invite_email_no_longer_mentions_a_signup_screen():
    mailer = (ROOT / "app/notifications/mailer.py").read_text(encoding="utf8")
    assert "Sign up" not in mailer


def test_password_login_is_the_default_and_code_signin_is_still_offered():
    assert "const S91_PASSWORD_LOGIN_ENABLED=true;" in AUTH
    assert "if(!S91_PASSWORD_LOGIN_ENABLED)s91ShowCodeSignIn(" in AUTH
    assert 'id="supabase-code-link"' in AUTH  # "Email me a sign-in code instead" remains available
    assert 'id="supabase-password" name="password" type="password" autocomplete="current-password"' in AUTH
