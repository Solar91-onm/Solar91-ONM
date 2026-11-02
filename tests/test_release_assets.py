"""A deployable page must reference assets that actually exist in this source tree."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / 'frontend/templates/index.html'


def _on_disk(url_path: str) -> Path:
    """/assets/... is served from assets/; /static/... from frontend/static/."""
    clean = url_path.split('?', 1)[0]
    if clean.startswith('/assets/'):
        return ROOT / 'assets' / clean[len('/assets/'):]
    return ROOT / 'frontend' / 'static' / clean[len('/static/'):]


def test_local_css_js_and_brand_assets_exist():
    page = PAGE.read_text(encoding='utf8')
    assets = set(re.findall(r'''(?:src|href)=["'](/(?:assets|static)/[^"']+)["']''', page))
    assert assets
    missing = [name for name in sorted(assets) if not _on_disk(name).is_file()]
    assert not missing, missing
    # Every script is listed once. The portal is a small, explicit set of modules,
    # not the 50-file layered bundle it replaced.
    js = re.findall(r'<script defer src="(/(?:assets|static)/js/[^\"]+)"', page)
    assert len(js) == len(set(js)), 'a script is listed twice'
    assert len(js) >= 10


def test_homepage_does_not_embed_production_tokens():
    page = PAGE.read_text(encoding='utf8')
    assert 'SUPABASE_SERVICE_ROLE_KEY' not in page
    assert 'database_url' not in page.lower()
    for secret in ('sk_live', 'sk_test', 'service_role', 'CLERK_SECRET'):
        assert secret not in page


def test_boot_splash_has_no_empty_form_label():
    page = PAGE.read_text(encoding='utf8')
    assert '<label aria-label="Filter dashboard by equipment"></label>' not in page


def test_signin_fields_have_autofill_metadata_and_names():
    # The sign-in panel moved to its own file unchanged; its markup must not drift.
    auth = (ROOT / 'frontend/static/js/auth-gate.js').read_text(encoding='utf8')
    assert 'id="clerk-code-email" name="email" type="email" autocomplete="email"' in auth
    assert 'id="clerk-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"' in auth
