"""Serialized immutable files and monotonic final pointers on one persistent volume."""
from datetime import date, datetime
import json
import os
from pathlib import Path
import re
import tempfile

from app.services.us_json import same_value
from app.services.swing_repository import database


def validate(package: dict) -> tuple:
    if not re.fullmatch(r"[a-f0-9]{64}", package.get("id", "")):
        raise ValueError("Invalid US publication identity")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,120}", package.get("universe", "")):
        raise ValueError("Invalid US publication universe")
    try:
        session = date.fromisoformat(package["session"])
        computed = datetime.fromisoformat(package["computed_at"])
        if session.isoformat() != package["session"] or computed.utcoffset() is None:
            raise ValueError()
    except (KeyError, ValueError, TypeError):
        raise ValueError("US publication requires a session and timezone-aware computed time") from None
    if package.get("state") not in {"final", "partial"}:
        raise ValueError("Invalid US publication state")
    return session, computed


def content(package: dict) -> dict:
    # Match the US source identity's observation-metadata exclusions, retaining
    # the original recorded observation when identical source content is replayed.
    result = {key: value for key, value in package.items() if key not in {"computed_at"}}
    if isinstance(result.get("instrument_snapshot"), dict):
        result["instrument_snapshot"] = {key: value for key, value in result["instrument_snapshot"].items() if key != "observed_at"}
    return result


def atomic_json(target: Path, payload: dict):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                         prefix=".us-publish-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(payload, handle, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def publish(package: dict, folder: Path):
    validate(package)
    # Serialize before any write so invalid numeric values cannot publish a file.
    json.dumps(package, allow_nan=False)
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / (package["id"] + ".json")
    with database(folder / ".publication.sqlite3") as connection:
        connection.execute("BEGIN IMMEDIATE")
        if target.exists():
            saved = json.loads(target.read_text(encoding="utf-8"))
            validate(saved)
            if not same_value(content(saved), content(package)):
                raise ValueError("US publication identity conflicts with immutable saved content")
        else:
            saved = package
        pointer = folder / (package["universe"] + "-latest-final.json")
        replace_pointer = saved["state"] == "final"
        if replace_pointer and pointer.exists():
            try:
                previous_pointer = json.loads(pointer.read_text(encoding="utf-8"))
                previous_id = previous_pointer["id"]
                if not re.fullmatch(r"[a-f0-9]{64}", previous_id):
                    raise ValueError()
                previous = json.loads((folder / (previous_id + ".json")).read_text(encoding="utf-8"))
                previous_order = validate(previous)
                if previous["id"] != previous_id or previous["universe"] != saved["universe"] or previous["state"] != "final" or previous_pointer.get("session") != previous["session"]:
                    raise ValueError()
            except (KeyError, ValueError, TypeError, OSError):
                raise ValueError("Last-final publication evidence is invalid; pointer was not replaced") from None
            # Session wins over wall-clock compute time. Equal-time conflicting
            # evidence remains explicit; do not silently choose whichever finished last.
            order = validate(saved)
            if order == previous_order and previous_id != saved["id"]:
                raise ValueError("Concurrent final publications have equal ordering; operator review required")
            replace_pointer = order > previous_order
        if not target.exists():
            atomic_json(target, saved)
        if replace_pointer:
            atomic_json(pointer, {"id": saved["id"], "session": saved["session"]})
    return target, saved
