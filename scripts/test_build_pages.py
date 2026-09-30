import hashlib
import io
import re
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import build_pages


class StaticAssetVersionTests(unittest.TestCase):
    def test_version_matches_content_and_changes_with_content(self):
        with tempfile.TemporaryDirectory() as directory:
            docs = Path(directory)
            script = docs / "static" / "js" / "app.js"
            script.parent.mkdir(parents=True)
            script.write_bytes(b"first version")
            html = '<script src="static/js/app.js"></script>'
            with patch.object(build_pages, "DOCS", docs):
                first = build_pages._version_static_assets(html)
                version = hashlib.sha256(script.read_bytes()).hexdigest()[:12]
                self.assertIn(f"static/js/app.js?v={version}", first)
                self.assertEqual(first, build_pages._version_static_assets(html))
                script.write_bytes(b"second version")
                self.assertNotEqual(first, build_pages._version_static_assets(html))

    def test_scripts_styles_and_icons_versioned_but_external_urls_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            docs = Path(directory)
            paths = ["static/js/ai.js", "static/css/style.css", "static/favicon.svg"]
            for name in paths:
                asset = docs / name
                asset.parent.mkdir(parents=True, exist_ok=True)
                asset.write_bytes(b"test asset")
            html = (
                '<script src="static/js/ai.js"></script>'
                "<link href='static/css/style.css' rel='stylesheet'>"
                '<link rel="icon" href="static/favicon.svg">'
                '<script src="https://cdn.example.test/library.js"></script>'
                '<a href="#career-guides">Guides</a>'
            )
            with patch.object(build_pages, "DOCS", docs):
                result = build_pages._version_static_assets(html)
            self.assertEqual(len(re.findall(r"\?v=[a-f0-9]{12}", result)), 3)
            self.assertIn('src="https://cdn.example.test/library.js"', result)
            self.assertIn('href="#career-guides"', result)

    def test_missing_static_asset_fails_the_build(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(build_pages, "DOCS", Path(directory)):
                with self.assertRaises(FileNotFoundError):
                    build_pages._version_static_assets('<script src="static/js/missing.js"></script>')

    def test_render_versions_assets_after_template_and_path_rewrites(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            templates = root / "templates"
            templates.mkdir()
            docs = root / "docs"
            script = docs / "static" / "js" / "app.js"
            script.parent.mkdir(parents=True)
            script.write_bytes(b"current script")
            (templates / "base.html").write_text(
                '<script src="/static/js/app.js"></script>{% block body %}{% endblock %}',
                encoding="utf-8",
            )
            (templates / "index.html").write_text(
                '{% extends "base.html" %}{% block body %}JobsPilot{% endblock %}',
                encoding="utf-8",
            )
            with patch.object(build_pages, "ROOT", root), patch.object(build_pages, "TPL_DIR", templates):
                with patch.object(build_pages, "DOCS", docs), redirect_stdout(io.StringIO()):
                    build_pages.render("index.html", "app.html")
            result = (docs / "app.html").read_text(encoding="utf-8")
            self.assertRegex(result, r'src="static/js/app.js\?v=[a-f0-9]{12}"')
            self.assertIn("JobsPilot", result)
            self.assertNotIn("{%", result)


if __name__ == "__main__":
    unittest.main()
