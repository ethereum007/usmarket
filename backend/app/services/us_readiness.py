"""Secret-free operator preflight; never claims hosted acceptance or data rights."""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from app.services.us_filings import valid_operator_agent
from app.services.us_origins import https_origin
from app.services.us_target import dedicated_supabase_origin

from app.us_auth import configured_invites
from app.services.swing_repository import database


def storage_probe(folder: Path) -> bool:
    # A temporary sibling database tests this directory without modifying saved
    # research, plan databases or the live refresh reservation. No market data.
    try:
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.us-readiness-', dir=folder) as temporary:
            source, backup = Path(temporary)/'probe.sqlite3', Path(temporary)/'backup.sqlite3'
            with database(source) as connection:
                connection.execute("INSERT INTO research_jobs VALUES (?,?,?,?)", ('probe','probe','probe','{}'))
            with closing(sqlite3.connect(source)) as connection, closing(sqlite3.connect(backup)) as destination:
                connection.backup(destination)
            with closing(sqlite3.connect(backup)) as restored:
                if restored.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    return False
                return restored.execute('SELECT owner FROM research_jobs WHERE id=?', ('probe',)).fetchone() == ('probe',)
    except (OSError, sqlite3.Error):
        return False


def report(check_storage=False):
    try:
        configured_invites()
        invitations = True
    except (ValueError, TypeError, AttributeError):
        invitations = False
    folder = Path(os.environ.get('DATA_DIR', ''))
    absolute = bool(os.environ.get('DATA_DIR')) and folder.is_absolute()
    plan_mode = os.environ.get('US_PLAN_STORE', 'sqlite')
    research_mode = os.environ.get('US_RESEARCH_STORE', 'local')
    job_mode = os.environ.get('US_JOB_STORE', 'local')
    modes_valid = plan_mode in {'sqlite','supabase'} and research_mode in {'local','supabase'} and job_mode in {'local','supabase'}
    all_remote = modes_valid and plan_mode == research_mode == job_mode == 'supabase'
    checks = {
        'storage_modes_valid': modes_valid,
        'job_research_storage_consistent': job_mode != 'supabase' or research_mode == 'supabase',
        'supabase_https_origin': https_origin(os.environ.get('SUPABASE_URL', '')),
        'supabase_dedicated_project_origin': dedicated_supabase_origin(os.environ.get('SUPABASE_URL', '')),
        'supabase_public_key_present': bool(os.environ.get('SUPABASE_ANON_KEY', '').strip()),
        'invited_user_ids_valid': invitations,
        'alpaca_credentials_present': all(os.environ.get(key, '').strip() for key in ('ALPACA_API_KEY','ALPACA_SECRET_KEY')),
        'sec_operator_contact_present': bool(os.environ.get('SEC_USER_AGENT', '').strip()),
        'sec_operator_header_valid': valid_operator_agent(os.environ.get('SEC_USER_AGENT', '')),
        'data_directory_requirement_satisfied': all_remote or absolute,
    }
    probe = 'not_run'
    if check_storage:
        probe = 'not_applicable_remote' if all_remote else ('passed' if absolute and storage_probe(folder) else 'failed')
    return {'configuration_ready': all(checks.values()) and probe != 'failed',
            'checks': checks, 'storage_probe': probe,
            'all_storage_remote': all_remote,
            'data_directory_required': not all_remote,
            'absolute_data_directory': absolute,
            'unverified': ['real_invited_sign_in_and_revocation', 'provider_access_and_audience_display_rights',
                           'persistent_volume_retention_after_restart', 'production_backups_and_restore',
                           'supabase_migrations_and_real_account_isolation', 'remote_worker_coordination_and_crash_recovery',
                           'aggregate_provider_rate_limits', 'private_frontend_proxy_and_browser_journey'],
            'scope': 'Local configuration and optional temporary SQLite probe only; not deployment approval'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-storage', action='store_true', help='Probe local storage in DATA_DIR; fully remote storage is reported as not applicable, never remotely verified')
    args = parser.parse_args()
    result = report(args.check_storage)
    print(json.dumps(result, sort_keys=True))
    return 0 if result['configuration_ready'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
