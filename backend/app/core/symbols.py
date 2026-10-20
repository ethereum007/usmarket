"""Canonical equity symbols and provider-specific transport formats."""

from __future__ import annotations

from typing import Any, Iterable


_EXCHANGE_PREFIXES = {"NSE", "BSE", "NFO", "BFO"}
_NSE_INDICES = {
    "NIFTY",
    "NIFTY 50",
    "NIFTY BANK",
    "NIFTY FIN SERVICE",
    "NIFTY MIDCAP SELECT",
}


def canonical_equity_symbol(value: Any) -> str:
    """Return the provider-neutral symbol used by caches, bars, and storage."""
    symbol = str(value or "").strip().upper()
    if ":" in symbol:
        prefix, remainder = symbol.split(":", 1)
        if prefix in _EXCHANGE_PREFIXES:
            symbol = remainder.strip()
    if symbol.endswith("-EQ"):
        symbol = symbol[:-3]
    return symbol


def canonical_equity_symbols(values: Iterable[Any]) -> list[str]:
    """Normalize and de-duplicate symbols without changing their order."""
    return list(
        dict.fromkeys(
            symbol
            for value in values
            if (symbol := canonical_equity_symbol(value))
        )
    )


def kite_equity_key(value: Any, exchange: str = "NSE") -> str:
    """Format one canonical cash-market symbol for Kite."""
    return f"{exchange.strip().upper()}:{canonical_equity_symbol(value)}"


def arrow_equity_symbol(value: Any, exchange: str = "NSE") -> str:
    """Format one canonical cash-market symbol for Arrow.

    Arrow requires the NSE series suffix even when the company symbol itself
    contains a hyphen (for example ``BAJAJ-AUTO-EQ``).
    """
    symbol = canonical_equity_symbol(value)
    if (
        exchange.strip().upper() != "NSE"
        or symbol in _NSE_INDICES
        or symbol.startswith("NIFTY ")
    ):
        return symbol
    return f"{symbol}-EQ" if symbol else ""
