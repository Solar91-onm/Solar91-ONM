from __future__ import annotations

import pytest

from app.auth.emails import canonical_email, is_gmail_family


@pytest.mark.parametrize(("raw", "expected"), [
    ("Ram.Kumar@Gmail.com", "ramkumar@gmail.com"),
    ("ramkumar+site@gmail.com", "ramkumar@gmail.com"),
    ("r.a.m@googlemail.com", "ram@gmail.com"),
    ("  RAMKUMAR@GMAIL.COM ", "ramkumar@gmail.com"),
    ("ram.kumar@company.com", "ram.kumar@company.com"),   # dots matter outside Gmail
    ("ram+x@company.com", "ram+x@company.com"),
    ("ramesh@gmail.com", "ramesh@gmail.com"),
    ("rameesh@gmail.com", "rameesh@gmail.com"),           # a typo is NOT the same person
    ("+tag@gmail.com", "+tag@gmail.com"),
    ("not-an-email", "not-an-email"),
])
def test_canonical_email(raw, expected):
    assert canonical_email(raw) == expected


def test_typo_is_never_merged():
    assert canonical_email("ramesh@gmail.com") != canonical_email("rameesh@gmail.com")


def test_is_gmail_family():
    assert is_gmail_family("a.b@googlemail.com") and is_gmail_family("A@GMAIL.com")
    assert not is_gmail_family("a@company.com") and not is_gmail_family("gmail.com")
