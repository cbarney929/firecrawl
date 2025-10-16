import os
import unittest
from unittest.mock import MagicMock, patch

from firecrawl import FirecrawlApp


class TestChangeTracking(unittest.TestCase):
    def _mock_response(self, body):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.ok = True
        mock_response.json.return_value = body
        return mock_response

    @patch("requests.post")
    def test_change_tracking_format(self, mock_post):
        mock_post.return_value = self._mock_response(
            {
                "success": True,
                "data": {
                    "markdown": "Test markdown content",
                    "changeTracking": {
                        "previousScrapeAt": "2023-01-01T00:00:00Z",
                        "changeStatus": "changed",
                        "visibility": "visible",
                    },
                },
            }
        )

        app = FirecrawlApp(api_key=os.environ.get("TEST_API_KEY", "dummy-api-key-for-testing"))
        result = app.scrape(
            "https://example.com",
            formats=["markdown", "changeTracking"],
        )

        args, kwargs = mock_post.call_args
        payload = kwargs["json"]

        self.assertEqual(payload["url"], "https://example.com")
        self.assertEqual(payload["formats"], ["markdown", "changeTracking"])
        self.assertEqual(result.markdown, "Test markdown content")
        self.assertEqual(result.change_tracking["changeStatus"], "changed")
        self.assertEqual(result.change_tracking["visibility"], "visible")
        self.assertEqual(result.change_tracking["previousScrapeAt"], "2023-01-01T00:00:00Z")

    @patch("requests.post")
    def test_change_tracking_options(self, mock_post):
        mock_post.return_value = self._mock_response(
            {
                "success": True,
                "data": {
                    "markdown": "Test markdown content",
                    "changeTracking": {
                        "previousScrapeAt": "2023-01-01T00:00:00Z",
                        "changeStatus": "changed",
                        "visibility": "visible",
                        "diff": {
                            "text": "@@ -1,1 +1,1 @@\\n-old content\\n+new content",
                            "json": {
                                "files": [
                                    {
                                        "from": None,
                                        "to": None,
                                        "chunks": [
                                            {
                                                "content": "@@ -1,1 +1,1 @@",
                                                "changes": [
                                                    {
                                                        "type": "del",
                                                        "content": "-old content",
                                                        "del": True,
                                                        "ln": 1,
                                                    },
                                                    {
                                                        "type": "add",
                                                        "content": "+new content",
                                                        "add": True,
                                                        "ln": 1,
                                                    },
                                                ],
                                            }
                                        ],
                                    }
                                ]
                            },
                        },
                        "json": {
                            "title": {
                                "previous": "Old Title",
                                "current": "New Title",
                            }
                        },
                    },
                },
            }
        )

        app = FirecrawlApp(api_key=os.environ.get("TEST_API_KEY", "dummy-api-key-for-testing"))
        change_tracking_format = {
            "type": "changeTracking",
            "modes": ["git-diff", "json"],
            "schema": {"type": "object", "properties": {"title": {"type": "string"}}},
        }

        result = app.scrape(
            "https://example.com",
            formats=["markdown", change_tracking_format],
        )

        args, kwargs = mock_post.call_args
        payload = kwargs["json"]

        self.assertIn("formats", payload)
        change_format_payload = next(
            item for item in payload["formats"] if isinstance(item, dict) and item.get("type") == "changeTracking"
        )
        self.assertEqual(change_format_payload["modes"], ["git-diff", "json"])
        self.assertEqual(
            change_format_payload["schema"],
            {"type": "object", "properties": {"title": {"type": "string"}}},
        )

        self.assertEqual(result.markdown, "Test markdown content")
        self.assertEqual(result.change_tracking["diff"]["text"], "@@ -1,1 +1,1 @@\\n-old content\\n+new content")
        self.assertEqual(result.change_tracking["json"]["title"]["previous"], "Old Title")
        self.assertEqual(result.change_tracking["json"]["title"]["current"], "New Title")


if __name__ == "__main__":
    unittest.main()
