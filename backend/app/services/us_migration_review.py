"""Read-only source migration fingerprint; never connects to or changes a database."""
import hashlib
import json
from pathlib import Path

NAMES = (
    '202610200001_us_plan_revisions.sql',
    '202610200002_us_research_packages.sql',
    '202610200003_us_refresh_jobs.sql',
    '202610260001_us_refresh_admission.sql',
    '202610260002_us_refresh_publication.sql',
    '202610260003_us_refresh_interruption.sql',
)


def manifest(folder=None):
    folder = Path(folder) if folder is not None else Path(__file__).resolve().parents[3]/'supabase'/'migrations'
    if {path.name for path in folder.glob('*.sql')} != set(NAMES):
        raise ValueError('Migration inventory requires review')
    files = []
    for name in NAMES:
        path = folder/name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Invalid source migration')
        # Fingerprint canonical UTF-8/LF text across Windows checkout and Linux CI.
        source = path.read_text(encoding='utf-8-sig')
        if not source.strip():
            raise ValueError('Empty source migration')
        files.append({'file':'supabase/migrations/'+name,
                      'sha256_utf8_lf':hashlib.sha256(source.encode('utf-8')).hexdigest()})
    fingerprint = hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()
    return {'schema_version':1,'migration_count':len(files),'files':files,'bundle_sha256':fingerprint,
            'target_project_reference':'etwmtakotrqlwwzttekc',
            'scope':'Source review only. No database connection, migration application or permission approval.',
            'hosted_application':'not_checked','activation_approval_required':True}


if __name__=='__main__':
    try:
        result = manifest()
    except (OSError,ValueError,UnicodeError):
        raise SystemExit('Source migration review unavailable; inspect inventory without activating storage') from None
    print(json.dumps(result,sort_keys=True,indent=2))
