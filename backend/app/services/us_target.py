"""User-selected standalone project identity; no hosted inspection or activation."""
from urllib.parse import urlsplit
from app.services.us_origins import https_origin

PROJECT_REFERENCE = 'apidhmrlawbjvisnadht'


def dedicated_supabase_origin(value):
    if not https_origin(value):
        return False
    parts = urlsplit(value)
    return parts.hostname == PROJECT_REFERENCE + '.supabase.co' and parts.port in {None,443}
