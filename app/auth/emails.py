"""One rule for deciding that two e-mail addresses are the same mailbox.

Gmail ignores dots and anything after a "+" in the part before the @, and gmail.com / googlemail.com are
the same service, so ram.kumar@gmail.com, ramkumar+site@gmail.com and RAMKUMAR@googlemail.com all reach one
inbox. Other providers do NOT work that way (dots matter), so they are only lower-cased.
Typos are never "corrected": a near miss may be a different real person.

Keep in step with s91CanonEmail() in frontend/static/js/00-auth-data-and-imports.js.
"""
from __future__ import annotations

GMAIL_DOMAINS = frozenset({"gmail.com", "googlemail.com"})


def is_gmail_family(email: object) -> bool:
    text = str(email or "").strip().lower()
    return "@" in text and text.rsplit("@", 1)[1] in GMAIL_DOMAINS


def canonical_email(email: object) -> str:
    text = str(email or "").strip().lower()
    if "@" not in text:
        return text
    local, domain = text.rsplit("@", 1)
    if domain in GMAIL_DOMAINS:
        collapsed = local.split("+", 1)[0].replace(".", "")
        if collapsed:
            return collapsed + "@gmail.com"
    return text
