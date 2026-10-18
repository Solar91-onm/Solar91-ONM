from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUTH = (ROOT / "frontend/static/js/00-auth-data-and-imports.js").read_text(encoding="utf8")


def test_password_signin_is_removed():
    assert "signInWithPassword" not in AUTH
    assert 'type="password"' not in AUTH


def test_email_code_signin_uses_clerk_flow():
    assert 'id="clerk-code-form"' in AUTH
    assert 'signInAttempt.prepareFirstFactor' in AUTH
    assert 'signInAttempt.attemptFirstFactor' in AUTH
    assert 'signUpAttempt.prepareEmailAddressVerification' in AUTH
    assert 'signUpAttempt.attemptEmailAddressVerification' in AUTH
    assert 'autocomplete="one-time-code"' in AUTH


def test_invite_email_no_longer_mentions_a_signup_screen():
    mailer = (ROOT / "app/notifications/mailer.py").read_text(encoding="utf8")
    assert "Sign up" not in mailer


def test_clerk_code_login_is_the_only_login_flow():
    assert '|| "clerk"' in AUTH
    assert 's91ShowClerkCodeSignIn("",errorMessage)' in AUTH
    assert "signInWithPassword" not in AUTH
