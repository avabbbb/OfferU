# Resume presentation and export

> Product interaction target: [Resume Canvas — Document-first, AI-assisted Resume Experience](../product/resume-canvas-design.md). This architecture document describes presentation/export mechanics; it must not be interpreted as requiring Proposal cards or a separate form editor as the primary Resume UX.

The canonical Resume owns content, `style_config`, `photo_url` and the school logo reference in `contact_json`. The editor and exports use the same React templates; a separate document or Agent-only resume is not created.

## Agent entry

Discover `resume_export` through the OfferU Skill/CLI, inspect the schemas, and read `get_resume`. The response includes the current `workspace_revision`, styles and image references.

`update_resume_design` accepts:

- `resume_id` and the read `expected_revision`;
- a partial `style_config`: template, A4/Letter, exact sizes in pt, spacing in pt, margins and image dimensions in mm, heading/rule hex colors;
- optional `photo` and `logo`, each containing `content_type` and `content_b64`, or `remove_photo` / `remove_logo`.

It does not accept summary, sections, identity or other career facts. Content changes continue through the existing resume review workflow. Agents submit a pending proposal; the user confirms it in OfferU. After confirmation, re-read the resume before requesting another mutation or `export_resume_pdf`.

Example operation input (use the actual revision returned by the read):

```json
{
  "resume_id": 68,
  "expected_revision": 3,
  "style_config": {
    "template": "reference",
    "bodySize": 10.5,
    "accentColorHex": "#7c3aed",
    "ruleColor": "#000000"
  }
}
```

## Persistence and editor behavior

The GUI image actions use `PATCH /api/resume/{id}/design`, which invokes the same Registry Operation. Images must be valid JPEG/PNG/WebP, no larger than 5 MiB or 25 million pixels. Arbitrary file paths and remote image URLs are not accepted by this operation. Binary inputs are redacted in operation audit records.

The transaction checks the expected revision, creates a before snapshot, writes new image files atomically, and commits the updated Resume with an after snapshot. A failed transaction removes only its newly created files. Previous image files remain available for version restoration. A stale proposal is rejected, and confirming the same proposal twice does not replay the mutation.

Editor autosaves are serialized and carry `expected_revision`. In-flight upload responses merge image fields without discarding text entered during the upload. The design panel supports upload/removal and precise numeric inputs; ordinary text changes still use the existing `update_resume_record` operation.

## Rendering

PDF and PNG exports and Agent PDF export share `resume_export.py`. It captures an immutable Resume snapshot and renders the dedicated React print route in managed headless Chromium. Fonts and images must load before printing. Print requests are restricted to the supported local frontend and canonical raster uploads. Failure is explicit; a simplified text-only PDF is not returned as successful export.

The print route is separate from the Workbench shell, and global Workbench heading decorations exclude resume documents. This avoids unnecessary context mutations and typography differences during printing.

The desktop sidecar includes the built React frontend and the matching managed Chromium headless shell. The renderer fulfills page, script, font and image requests directly from those read-only bundled resources, without starting or contacting a frontend server. Missing resources fail explicitly. In development, it uses a ready Vite server when available and otherwise uses `frontend/dist`. The local URL is only a virtual origin when serving bundled resources. Path canonicalization confines reads to the frontend bundle or uploads directory.

Both sidecar builders package `resume-frontend`, `resume-browsers` and Playwright's driver. `sidecar_entry.configure_runtime()` points Playwright at the bundled browser cache. The desktop image policy permits the specific local `/uploads/` path so photos and logos can appear in the WebView. Full installer execution and cross-platform font fidelity remain separate release gates. Arbitrary-position editing, automatic multi-page balancing and lossless arbitrary-PDF import are not implemented by this slice.

The browser version is installed by the build environment's Python Playwright package using `playwright install --only-shell chromium`, rather than depending on the user's system browser. Packaged startup overrides an inherited browser-cache path so another installed Playwright version cannot silently select an incompatible browser. User uploads remain in the writable data directory, separate from the bundled renderer resources.

## Verification

From `backend/`, run the design, renderer, workspace, Agent surface and confirmation tests. The browser test is opt-in and uses an isolated SQLite database, real resume ASGI routes/Registry operations, and the real PDF renderer; unrelated shell APIs are fixtures.

```powershell
python -m pytest tests/test_resume_design.py tests/test_resume_render_contract.py tests/test_resume_workspace.py tests/test_agent_tool_surface.py tests/test_agent_skill_projections.py tests/test_agent_control_plane.py -q
$env:OFFERU_RESUME_BROWSER_TEST = '1'
python -m pytest tests/test_resume_design_browser.py -q
```

Start the frontend on the supported 7410 port before the editor browser test and use the installed Playwright managed browser cache. The bundled-export test only requires built `frontend/dist`; it forbids both HTTP client calls and browser network forwarding, and verifies Chinese text, two images and heading color in the actual generated PDF. Test storage is under the configured H-drive temporary root. The editor regression covers editing, both uploads, reload, PDF image/color inspection, removal and restoration. Automated confirmation tests simulate the UI boundary against fixture data; they are not proof of an independent human confirmation or a full live Agent-native session.

Implementation references: [SQLAlchemy async explicit loading](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html#preventing-implicit-io-when-using-asyncsession), [Pillow image verification](https://pillow.readthedocs.io/en/stable/reference/Image.html#PIL.Image.Image.verify), [Playwright headless shell](https://playwright.dev/python/docs/browsers#chromium-headless-shell), [Playwright with PyInstaller](https://playwright.dev/python/docs/library#pyinstaller).
