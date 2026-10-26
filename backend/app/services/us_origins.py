"""Shared validation for configured HTTPS origins before sending credentials."""
from urllib.parse import urlsplit


def https_origin(value):
    if not isinstance(value, str) or not value or any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value) or '\\' in value:
        return False
    try:
        parts = urlsplit(value)
        parts.port  # Validate optional port syntax without printing the origin.
        return bool(parts.scheme == 'https' and parts.hostname and not parts.username
                    and not parts.password and parts.path in {'', '/'} and not parts.query and not parts.fragment)
    except ValueError:
        return False


