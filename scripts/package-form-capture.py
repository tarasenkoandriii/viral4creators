"""Build/check deterministic, source-only browser capture archive."""
from pathlib import Path
import io
import sys
import zipfile
root = Path(__file__).resolve().parent.parent
source = root / 'tools/form-capture'
out = root / 'assist/public/downloads/qa-form-capture.zip'
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in ['manifest.json', 'capture.js', 'quick-audit.js', 'popup.html', 'popup.js', 'workbench.js', 'workbench-ui.js', 'README.md', 'package.json']:
        info = zipfile.ZipInfo(name, (2026, 10, 15, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, (source / name).read_bytes())
if '--check' in sys.argv:
    if not out.exists() or out.read_bytes() != buffer.getvalue():
        raise SystemExit('Capture archive differs from sources: run python3 scripts/package-form-capture.py')
else:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(buffer.getvalue())
