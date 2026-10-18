"""Transactional e-mail (Resend HTTP API).

Resend is used over HTTPS on purpose: hosted free tiers (e.g. Render) block outbound SMTP ports.
Sending is best-effort: a failure never blocks saving a person, the caller just reports it.
"""
from __future__ import annotations

import base64
import logging
from functools import lru_cache
from html import escape
from pathlib import Path

import httpx

from app.core.config import get_settings

log = logging.getLogger("solar91.mail")
RESEND_URL = "https://api.resend.com/emails"


def mail_configured() -> bool:
    s = get_settings()
    return bool(s.resend_api_key and s.mail_from)


def app_url() -> str:
    s = get_settings()
    if s.app_public_url:
        return s.app_public_url.rstrip("/")
    for origin in s.origins:
        if "localhost" not in origin and "127.0.0.1" not in origin:
            return origin
    return s.origins[0] if s.origins else ""


BRAND_NAME = "SOLAR 91"          # organisation name shown as the logo's alt text / fallback
LOGO_PATH = "/static/brand/solar91-logo-email.png"
LOGO_FILE = Path(__file__).resolve().parents[2] / "frontend" / "static" / "brand" / "solar91-logo-email.png"
LOGO_CID = "solar91-logo"        # referenced in the HTML as src="cid:solar91-logo"


@lru_cache
def _logo_b64() -> str | None:
    """The logo is sent INSIDE the email (inline attachment) so it shows even when the
    portal URL is private/localhost or the mail client blocks remote images."""
    try:
        return base64.b64encode(LOGO_FILE.read_bytes()).decode("ascii")
    except OSError:
        log.warning("invite email: logo file missing at %s", LOGO_FILE)
        return None

ROLE_POINTS = {
    "Assignee": [
        "See and act on every issue for your equipment types, in all plants",
        "Run scheduled maintenance and panel-washing tasks",
        "Log your work with before / after photos as proof",
    ],
    "Site Engineer": [
        "Raise and resolve issues at your plant",
        "Complete scheduled maintenance and washing jobs",
        "Log your work with before / after photos as proof",
    ],
    "O&M Head": [
        "Manage people, plants and who is responsible for what",
        "Track issues and maintenance across every plant",
        "Review reports and performance",
    ],
    "Administration": [
        "View the whole portfolio, performance and reports",
        "Create problem-based maintenance tasks",
        "Read-only access to everything else",
    ],
}


def _invite_html(name: str, email: str, role: str, scope: str, invited_by: str, url: str, logo_src: str | None = None) -> str:
    n, e, r, sc, by, u = (escape(x or "") for x in (name, email, role, scope, invited_by, url))
    first = escape((name or "").strip().split(" ")[0]) if name and name.strip().lower() != (email or "").lower() else ""
    src = logo_src or (escape(url.rstrip("/")) + LOGO_PATH if url else "")
    logo = (
        f'<img src="{src}" alt="{BRAND_NAME}" width="170" style="display:block;border:0;outline:none;height:auto;max-width:170px">'
        if src else f'<span style="font-size:24px;font-weight:700;color:#13261B;letter-spacing:.5px">{BRAND_NAME}</span>'
    )
    who = by or "Your O&amp;M Head"
    points = ROLE_POINTS.get(role, ["Your access will be set by your O&amp;M Head"])
    point_rows = "".join(
        f'<tr><td width="30" valign="top" style="padding:7px 0"><div style="width:22px;height:22px;line-height:22px;border-radius:11px;background:#DDF1E3;color:#1F5C38;font-size:13px;font-weight:700;text-align:center">&#10003;</div></td>'
        f'<td valign="middle" style="padding:7px 0;font-size:14px;line-height:1.5;color:#2B4033">{escape(t).replace("&amp;amp;", "&amp;")}</td></tr>'
        for t in points
    )

    def step(num: str, title: str, text: str) -> str:
        return (
            f'<tr><td width="44" valign="top" style="padding:9px 0"><div style="width:32px;height:32px;line-height:32px;border-radius:16px;background:#F5B821;color:#0F3D22;font-weight:800;font-size:15px;text-align:center">{num}</div></td>'
            f'<td valign="middle" style="padding:9px 0;font-size:14px;line-height:1.5;color:#2B4033"><b style="color:#0F3D22">{title}</b><br>{text}</td></tr>'
        )

    button = (
        f'<a href="{u}" style="display:inline-block;background:#1F5C38;background-image:linear-gradient(135deg,#2E7D4F,#1F5C38);color:#ffffff;text-decoration:none;'
        f'font-weight:700;font-size:16px;padding:15px 38px;border-radius:12px;border-bottom:3px solid #0F3D22">Sign in to Solar91 &nbsp;&rarr;</a>'
    ) if u else ""
    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#E9F0EB;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#13261B">
<span style="display:none;max-height:0;overflow:hidden">{who} added you to the Solar91 O&amp;M portal as {r}. Your access is ready.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9F0EB;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #D5E2D9">

 <tr><td style="background:#ffffff;padding:24px 34px 18px">{logo}</td></tr>

 <tr><td bgcolor="#0F3D22" style="background:#0F3D22;background-image:linear-gradient(135deg,#0F3D22 0%,#1F5C38 60%,#2E7D4F 100%);padding:38px 34px 34px">
   <div style="display:inline-block;background:#F5B821;color:#0F3D22;font-size:11px;font-weight:800;letter-spacing:.12em;padding:5px 12px;border-radius:20px">&#9728; YOU&rsquo;RE INVITED</div>
   <h1 style="margin:16px 0 8px;font-size:30px;line-height:1.2;color:#ffffff;font-weight:800">Welcome to the team{', ' + first if first else ''}!</h1>
   <p style="margin:0;font-size:15px;line-height:1.6;color:#BFE0CB"><b style="color:#ffffff">{who}</b> has added you to the Solar91 O&amp;M Command Center. Your access is already set up &mdash; you only need to sign in.</p>
 </td></tr>
 <tr><td style="background:#F5B821;height:5px;line-height:5px;font-size:0">&nbsp;</td></tr>

 <tr><td style="padding:30px 34px 6px">
   <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
     <td width="48%" valign="top" style="background:#F1F8F3;border:1px solid #D5E8DB;border-radius:14px;padding:16px 18px">
       <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6B7F72;font-weight:700">&#128100; Your role</div>
       <div style="font-size:19px;font-weight:800;color:#1F5C38;margin-top:5px">{r}</div>
     </td>
     <td width="4%">&nbsp;</td>
     <td width="48%" valign="top" style="background:#FFF8E5;border:1px solid #F3DFA3;border-radius:14px;padding:16px 18px">
       <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8A7424;font-weight:700">&#9889; You will work on</div>
       <div style="font-size:15px;font-weight:700;color:#13261B;margin-top:5px;line-height:1.4">{sc}</div>
     </td>
   </tr></table>
 </td></tr>

 <tr><td style="padding:24px 34px 4px">
   <div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#6B7F72;font-weight:700;margin-bottom:6px">What you can do</div>
   <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{point_rows}</table>
 </td></tr>

 <tr><td style="padding:26px 34px 6px">
   <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF7E0;border:1px solid #F5D77A;border-left:5px solid #F5B821;border-radius:12px"><tr><td style="padding:16px 18px">
     <div style="font-size:15px;font-weight:800;color:#6B4E00">&#128260; Your work can change later</div>
     <div style="font-size:13.5px;line-height:1.6;color:#4F4320;margin-top:5px">Responsibilities in O&amp;M move as plants and teams grow. Your O&amp;M Head can update your equipment types or plants at any time, and the change appears the next time you open the portal &mdash; <b>no new invitation needed</b>.</div>
   </td></tr></table>
 </td></tr>

 <tr><td align="center" style="padding:30px 34px 8px">{button}</td></tr>

 <tr><td style="padding:20px 34px 4px">
   <div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#6B7F72;font-weight:700;margin-bottom:4px">Get started in 3 steps</div>
   <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
     {step("1", "Open the portal", "Tap the green button above.")}
     {step("2", "Sign in with this exact email", f'<span style="color:#1F5C38;font-weight:700">{e}</span><br>No password needed: tap &ldquo;Email me a sign-in code instead&rdquo;, then enter the 6-digit code we send you.')}
     {step("3", "Start working", "Your role and assignments are waiting for you.")}
   </table>
 </td></tr>

 <tr><td style="padding:22px 34px 30px"><div style="border-top:1px solid #E4ECE6;padding-top:16px;font-size:12px;color:#7A8C80;line-height:1.7">
   <b style="color:#4A6053">Important:</b> a different email address will not get this access.<br>
   Button not working? Copy this link into your browser:<br><span style="color:#1F5C38;word-break:break-all">{u}</span><br><br>
   Did not expect this email? You can safely ignore it.</div></td></tr>
</table>
<div style="font-size:11px;color:#8A9A90;margin-top:14px">&copy; Solar91 &middot; O&amp;M Command Center</div>
</td></tr></table></body></html>"""


def _invite_text(name: str, email: str, role: str, scope: str, invited_by: str, url: str) -> str:
    return (
        f"{'Hi ' + name + ',' if name else 'Hello,'}\n\n"
        f"Welcome to the team! {invited_by or 'Your O&M Head'} has added you to the Solar91 O&M portal.\n\n"
        f"Role: {role}\nYou will work on: {scope}\n\n"
        f"Sign in here: {url}\n"
        f"Use this exact email address: {email}\n\n"
        "Your work can change later: your O&M Head can update your equipment types or plants as "
        "responsibilities change. Changes appear next time you open the portal - no new invite needed.\n\n"
        "Did not expect this email? You can ignore it.\n"
    )


def send_invite_email(*, to_email: str, name: str, role: str, scope: str, invited_by: str) -> tuple[bool, str]:
    """Returns (sent, reason). Never raises."""
    s = get_settings()
    if not mail_configured():
        return False, "Email is not set up on the server (RESEND_API_KEY / MAIL_FROM missing)"
    url = app_url()
    logo = _logo_b64()
    payload = {
        "from": s.mail_from,
        "to": [to_email],
        "subject": "You're invited to the Solar91 O&M portal",
        "html": _invite_html(name, to_email, role, scope, invited_by, url,
                             logo_src=f"cid:{LOGO_CID}" if logo else None),
        "text": _invite_text(name, to_email, role, scope, invited_by, url),
    }
    if logo:
        payload["attachments"] = [{
            "filename": "solar91-logo.png", "content": logo,
            "content_type": "image/png", "content_id": LOGO_CID,
        }]
    try:
        r = httpx.post(RESEND_URL, json=payload, timeout=10.0,
                       headers={"Authorization": f"Bearer {s.resend_api_key}"})
    except Exception as exc:  # network / DNS / timeout
        log.warning("invite email failed: %s", exc)
        return False, "Could not reach the email service"
    if r.status_code >= 300:
        log.warning("invite email rejected %s: %s", r.status_code, r.text[:300])
        try:
            detail = r.json().get("message") or r.text[:160]
        except Exception:
            detail = r.text[:160]
        return False, f"Email service refused it: {detail}"
    return True, "sent"


def send_pm_alert_email(
    *,
    to_email: str,
    name: str,
    title: str,
    message: str,
    work_order_no: str,
) -> tuple[bool, str]:
    """Send an opted-in PM alert; an email failure must not stop the scheduled job."""
    s = get_settings()
    if not mail_configured():
        log.warning("PM alert email not sent because email is not configured for %s", to_email)
        return False, "Email is not set up on the server"
    url = app_url()
    safe_name = escape(name or "team member")
    safe_title = escape(title)
    safe_message = escape(message)
    safe_work_order = escape(work_order_no)
    payload = {
        "from": s.mail_from,
        "to": [to_email],
        "subject": f"SOLAR 91 PM alert — {title}",
        "html": (
            f"<p>Hello {safe_name},</p><p><b>{safe_title}</b></p>"
            f"<p>{safe_message}</p><p>Work order: {safe_work_order}</p>"
            f'<p><a href="{escape(url, quote=True)}">Open Solar91 O&amp;M</a></p>'
        ),
        "text": (
            f"Hello {name or 'team member'},\n\n{title}\n{message}\n"
            f"Work order: {work_order_no}\n{url}"
        ),
    }
    try:
        response = httpx.post(
            RESEND_URL,
            json=payload,
            timeout=10.0,
            headers={"Authorization": f"Bearer {s.resend_api_key}"},
        )
    except httpx.HTTPError as exc:
        log.warning("PM alert email failed for %s: %s", to_email, exc)
        return False, "Could not reach the email service"
    if response.status_code >= 300:
        log.warning("PM alert email rejected %s: %s", response.status_code, response.text[:300])
        return False, "Email service refused it"
    return True, "sent"
