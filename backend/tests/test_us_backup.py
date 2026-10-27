from contextlib import closing
import json
import sqlite3
from pathlib import Path
from unittest.mock import patch
import pytest
from app.services import us_backup as backup, swing_repository as repo


def test_online_backup_includes_wal_and_preserves_owner_revisions(tmp_path):
    source=tmp_path/'source.sqlite3';target=tmp_path/'private-backup.sqlite3'
    repo.save_plan('owner','plan',0,{'setup_id':'setup','notes':'first'},database_path=source)
    with closing(sqlite3.connect(source)) as writer:
        writer.execute('PRAGMA journal_mode=WAL')
        repo.save_plan('owner','plan',1,{'setup_id':'setup','notes':'second'},database_path=source)
        assert Path(str(source)+'-wal').stat().st_size > 0
        writer.execute('BEGIN IMMEDIATE')
        writer.execute('INSERT INTO research_jobs VALUES (?,?,?,?)',('uncommitted','owner','now','{}'))
        backup.backup_database(source,target)
        writer.rollback()
    assert repo.get_job('uncommitted','owner',database_path=target) is None
    assert repo.get_plan('owner','plan',1,database_path=target)['notes']=='first'
    assert repo.get_plan('owner','plan',2,database_path=target)['notes']=='second'
    assert repo.get_plan('foreign','plan',2,database_path=target) is None
    assert repo.get_plan('owner','plan',2,database_path=source)['notes']=='second'


def test_existing_target_is_never_overwritten(tmp_path):
    source=tmp_path/'source.sqlite3';target=tmp_path/'existing'
    with repo.database(source):pass
    target.write_bytes(b'private existing content')
    with pytest.raises(FileExistsError):backup.backup_database(source,target)
    assert target.read_bytes()==b'private existing content'


def test_invalid_source_cleans_only_new_target(tmp_path):
    source=tmp_path/'invalid';source.write_bytes(b'private invalid content')
    target=tmp_path/'new-backup'
    with pytest.raises(sqlite3.DatabaseError):backup.backup_database(source,target)
    assert not target.exists() and source.read_bytes()==b'private invalid content'


def test_repository_and_same_source_destinations_are_rejected(tmp_path):
    source=tmp_path/'source.sqlite3'
    with repo.database(source):pass
    with pytest.raises(ValueError):backup.backup_database(source,source)
    with pytest.raises(ValueError):backup.backup_database(source,backup.REPOSITORY/'should-not-exist.sqlite3')


def test_missing_source_does_not_create_empty_database(tmp_path):
    source=tmp_path/'missing';target=tmp_path/'new'
    with pytest.raises(FileNotFoundError):backup.backup_database(source,target)
    assert not source.exists() and not target.exists()


def test_cli_failure_is_sanitized_and_nonzero(tmp_path,capsys):
    with patch.dict(backup.os.environ,{'DATA_DIR':str(tmp_path)},clear=True),patch('sys.argv',['backup','--kind','plans','--output',str(tmp_path/'backup')]):
        assert backup.main()==1
    text=capsys.readouterr().out
    assert json.loads(text)['success'] is False and str(tmp_path) not in text


def test_job_backup_survives_read_from_new_store(tmp_path):
    source=tmp_path/'jobs.sqlite3';target=tmp_path/'backup.sqlite3'
    repo.save_job({'id':'job','owner':'owner','state':'completed','package_id':'a'*64},database_path=source)
    backup.backup_database(source,target)
    assert repo.get_job('job','owner',database_path=target)['package_id']=='a'*64
    assert repo.get_job('job','foreign',database_path=target) is None


def test_symlink_destination_is_not_followed(tmp_path):
    source=tmp_path/'source.sqlite3';link=tmp_path/'link';destination=tmp_path/'should-not-exist'
    with repo.database(source):pass
    try:link.symlink_to(destination)
    except OSError:pytest.skip('Symlink creation is unavailable for this Windows account')
    with pytest.raises(ValueError):backup.backup_database(source,link)
    assert link.is_symlink() and not destination.exists()


@pytest.mark.parametrize('kind,selector',[('plans','US_PLAN_STORE'),('jobs','US_JOB_STORE')])
@pytest.mark.parametrize('mode',['supabase','private-invalid-mode',''])
def test_cli_rejects_remote_or_invalid_mode_without_backing_up_stale_local_files(tmp_path,capsys,kind,selector,mode):
    source=tmp_path/backup.DATABASES[kind]
    source.write_bytes(b'Private stale local database sentinel')
    target=tmp_path/'new-backup.sqlite3'
    values={'DATA_DIR':str(tmp_path),selector:mode}
    with patch.dict(backup.os.environ,values,clear=True),patch('sys.argv',['backup','--kind',kind,'--output',str(target)]),patch.object(backup,'backup_database') as copy:
        assert backup.main()==1
    copy.assert_not_called()
    assert not target.exists()
    assert source.read_bytes()==b'Private stale local database sentinel'
    report=capsys.readouterr().out
    assert json.loads(report)['success'] is False
    assert str(tmp_path) not in report and 'private-invalid-mode' not in report and 'sentinel' not in report


@pytest.mark.parametrize('kind,selector,local',[('plans','US_PLAN_STORE','sqlite'),('jobs','US_JOB_STORE','local')])
@pytest.mark.parametrize('explicit',[False,True])
def test_cli_local_defaults_and_explicit_modes_still_back_up_requested_store(tmp_path,capsys,kind,selector,local,explicit):
    source=tmp_path/backup.DATABASES[kind]
    with repo.database(source):pass
    target=tmp_path/'private-copy.sqlite3'
    values={'DATA_DIR':str(tmp_path)}
    if explicit:values[selector]=local
    # The other kind may already be remote; do not reject the selected local store.
    values['US_JOB_STORE' if kind=='plans' else 'US_PLAN_STORE']='supabase'
    with patch.dict(backup.os.environ,values,clear=True),patch('sys.argv',['backup','--kind',kind,'--output',str(target)]):
        assert backup.main()==0
    assert json.loads(capsys.readouterr().out)['integrity']=='ok'
    with closing(sqlite3.connect(target)) as connection:
        assert connection.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
