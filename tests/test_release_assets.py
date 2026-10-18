"""A deployable page must reference assets that actually exist in this source tree."""
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]

def test_local_css_js_and_brand_assets_exist():
    page=(ROOT/'frontend/templates/index.html').read_text(encoding='utf8')
    assets=set(re.findall(r'''(?:src|href)=["'](/static/[^"']+)["']''',page))
    assert assets
    missing=[name for name in assets if not (ROOT/'frontend'/name.split('?',1)[0].lstrip('/')).is_file()]
    assert not missing,missing
    js=re.findall(r'<script defer src="(/static/js/[^\"]+)"',page)
    assert len(js)==len(set(js))
    assert len(js)>25

def test_homepage_does_not_embed_production_tokens():
    page=(ROOT/'frontend/templates/index.html').read_text(encoding='utf8')
    assert 'SUPABASE_SERVICE_ROLE_KEY' not in page
    assert 'database_url' not in page.lower()
    assert 'document.cookie' not in (ROOT/'frontend/static/js/00-loop-guard.js').read_text()

def test_boot_splash_has_no_empty_form_label():
    page=(ROOT/'frontend/templates/index.html').read_text(encoding='utf8')
    assert '<label aria-label="Filter dashboard by equipment"></label>' not in page

def test_signin_fields_have_autofill_metadata_and_names():
    auth=(ROOT/'frontend/static/js/00-auth-data-and-imports.js').read_text(encoding='utf8')
    assert 'id="clerk-code-email" name="email" type="email" autocomplete="email"' in auth
    assert 'id="clerk-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"' in auth
