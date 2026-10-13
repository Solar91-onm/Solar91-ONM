# UX / Performance Pass

This pass keeps the existing Solar91 visual identity, routes, role model and global JavaScript names. It does not introduce a framework or build step.

## Audit summary

| Page | Main issue observed | Evidence area | Severity | Change strategy | Risk |
| --- | --- | --- | --- | --- | --- |
| Command Center | Full `#app` replacement makes small interactions feel jumpy | `02-core-render-and-dashboard.js: render()` | High | Preserve scroll/focus and batch safe renders | Low |
| Plants | Filter/navigation work rebuilds the shell | core render + plant renderer | High | State restoration; keep output unchanged | Low |
| Plant detail | Dense page and no direct asset path | `renderPlantPage()` | Medium | Small Equipment panel only | Low |
| Site Issues | Large register/filter interaction | issue register wrappers | High | Keep existing register; avoid adding more full-render work | Medium |
| Preventive Maintenance | Large planned-work dashboard | PM renderer/wrappers | High | Preserve layout; equipment picker uses current register | Low |
| Washing | Several enhancement layers but mature workflow | `05-*`, `20-*`, `21-*` | Medium | No redesign; retain supplied washing specification | Low |
| Equipment Register | Hard cap/full re-render and incomplete ownership/service data | `20-modern-ui-2026.js` | High | Server pagination, debounced query, drawer | Medium |
| Reports | Multiple same-weight controls | reports renderer | Medium | No destructive declutter in this pass | Low |
| Data / Imports | Dense action surface | data renderer | Medium | Existing hierarchy retained | Low |
| Team & Access | Role controls are information-dense | team renderer | Medium | Existing permission UI retained | Low |
| Settings | Multiple sections at equal visual weight | settings renderer | Medium | Existing structure retained | Low |

## Implemented invisible/safe improvements

- `render()` snapshots and restores focused control, text selection, window scroll and `.content` scroll across existing full-shell renders.
- `scheduleRender()` provides requestAnimationFrame batching for safe callers without replacing the global `render` function or monkey-patch chain.
- Equipment search is debounced and results are server-paginated rather than capped at 400 rows.
- Static assets are versioned in `index.html`; versioned static requests receive one-year immutable cache headers. Existing FastAPI GZip middleware remains in place.
- Initial app HTML contains a Solar91 loading skeleton and “waking up the server” message instead of a blank screen.
- Equipment table headers are sticky; mobile keeps the first equipment column accessible and moves secondary navigation under **More**.
- Focus-visible styles, reduced-motion support, Esc-to-close and Tab focus containment were added without changing modal functions.
- Hash routes mirror the existing navigation state so refresh/share/Back can return to the same top-level view. Equipment filter state is encoded in the hash and retained in existing local storage.

## Measurement plan

For production/browser profiling, capture these before/after on the same account and dataset:

- `performance.now()` around `render()` for Command Center, Site Issues, PM, Washing and Equipment Register.
- DOM node count: `document.getElementsByTagName('*').length` after each view renders.
- Number of render calls for one search/filter action.
- MutationObserver callback counts over a 30-second idle period and one register interaction.
- Network request count + transferred bytes on cold first load and warm reload.
- Equipment rows present in the DOM for 500+ item datasets.

The automated suite validates behaviour, but browser timing numbers should be taken in the deployed Render/Supabase environment because local test timings do not represent cold starts or network transfer.

## Rollback

All DB work is additive in migration 013. Frontend changes are isolated to existing JS/CSS/template files and can be reverted independently. Removing the v2 UI does not require dropping the added nullable columns. Do not roll back by editing historical migrations.
