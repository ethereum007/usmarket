from __future__ import annotations

import unittest
from unittest.mock import patch

from app.services import scanner_service


class ScannerServiceTest(unittest.TestCase):
    def test_resolve_tokens_warms_cold_instrument_cache_once(self) -> None:
        kite = object()

        with (
            patch.object(
                scanner_service.instrument_cache,
                "get_all_tokens",
                side_effect=[{}, {"NETWEB": 12345, "KAYNES": 23456}],
            ) as get_all_tokens,
            patch.object(scanner_service.instrument_cache, "load_instruments", return_value=5000) as load_instruments,
        ):
            tokens = scanner_service._resolve_tokens(["NETWEB", "KAYNES", "MISSING"], kite)

        self.assertEqual(tokens, {"NETWEB": 12345, "KAYNES": 23456})
        load_instruments.assert_called_once_with(kite)
        self.assertEqual(get_all_tokens.call_count, 2)

    def test_resolve_tokens_does_not_warm_without_kite(self) -> None:
        with (
            patch.object(scanner_service.instrument_cache, "get_all_tokens", return_value={}),
            patch.object(scanner_service.instrument_cache, "load_instruments") as load_instruments,
        ):
            tokens = scanner_service._resolve_tokens(["NETWEB"], None)

        self.assertEqual(tokens, {})
        load_instruments.assert_not_called()


if __name__ == "__main__":
    unittest.main()
