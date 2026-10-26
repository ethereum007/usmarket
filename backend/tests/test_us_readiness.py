import json
from pathlib import Path
from unittest.mock import patch
import pytest
from app.services import us_readiness as ready


def environment(root):
    return {'SUPABASE_URL':'https://us.example','SUPABASE_ANON_KEY':'private-test-key',
            'US_INVITED_USER_IDS':'11111111-1111-4111-8111-111111111111',
            'ALPACA_API_KEY':'private-alpaca-key','ALPACA_SECRET_KEY':'private-alpaca-secret',
            'SEC_USER_AGENT':'private-operator-contact','DATA_DIR':str(root)}


def test_configured_probe_preserves_real_files_and_does_not_claim_hosted_readiness(tmp_path):
    marker=tmp_path/'us-plans.sqlite3';marker.write_bytes(b'private real database sentinel')
    with patch.dict(ready.os.environ,environment(tmp_path),clear=True):result=ready.report(True)
    assert result['configuration_ready'] and result['storage_probe']=='passed'
    assert marker.read_bytes()==b'private real database sentinel'
    assert list(tmp_path.iterdir())==[marker]
    assert 'provider_access_and_audience_display_rights' in result['unverified']
    assert 'private-' not in json.dumps(result)


@pytest.mark.parametrize('name',['SUPABASE_URL','SUPABASE_ANON_KEY','US_INVITED_USER_IDS','ALPACA_API_KEY','ALPACA_SECRET_KEY','SEC_USER_AGENT','DATA_DIR'])
def test_missing_configuration_fails_without_disclosing_values(tmp_path,name):
    values=environment(tmp_path);values.pop(name)
    with patch.dict(ready.os.environ,values,clear=True):result=ready.report()
    assert not result['configuration_ready'] and result['storage_probe']=='not_run'
    assert 'private-' not in json.dumps(result) and str(tmp_path) not in json.dumps(result)


@pytest.mark.parametrize('origin',['http://us.example','https://user:private@us.example','https://us.example/auth','https://us.example?private=value','not-url'])
def test_invalid_auth_origin_is_not_ready(tmp_path,origin):
    values=environment(tmp_path);values['SUPABASE_URL']=origin
    with patch.dict(ready.os.environ,values,clear=True):assert not ready.report()['checks']['supabase_https_origin']


def test_storage_failure_is_sanitized(tmp_path):
    with patch.dict(ready.os.environ,environment(tmp_path),clear=True),patch.object(ready,'database',side_effect=OSError('private disk detail')):
        result=ready.report(True)
    assert not result['configuration_ready'] and result['storage_probe']=='failed'
    assert 'private' not in json.dumps(result).replace('private_frontend_proxy_and_browser_journey','')
    assert list(tmp_path.iterdir())==[]


def test_probe_requires_explicit_absolute_data_directory(tmp_path):
    values=environment(tmp_path);values['DATA_DIR']='relative-private-folder'
    with patch.dict(ready.os.environ,values,clear=True),patch.object(ready,'storage_probe') as probe:
        result=ready.report(True)
    assert result['storage_probe']=='failed' and not result['configuration_ready']
    probe.assert_not_called()


@pytest.mark.parametrize('configured,exit_code',[(True,0),(False,1)])
def test_cli_exit_code_matches_report_without_extra_output(configured,exit_code,capsys):
    with patch('sys.argv',['us_readiness']),patch.object(ready,'report',return_value={'configuration_ready':configured}) as report:
        assert ready.main()==exit_code
    report.assert_called_once_with(False)
    assert json.loads(capsys.readouterr().out)=={'configuration_ready':configured}


@pytest.mark.parametrize('extra',[
    {'US_PLAN_STORE':'private-secret-invalid'},
    {'US_RESEARCH_STORE':'private-secret-invalid'},
    {'US_JOB_STORE':'private-secret-invalid'},
    {'US_JOB_STORE':'supabase','US_RESEARCH_STORE':'local'},
])
def test_invalid_or_inconsistent_remote_storage_cannot_pass_preflight(tmp_path,extra):
    with patch.dict(ready.os.environ,{**environment(tmp_path),**extra},clear=True):
        result=ready.report()
    assert not result['configuration_ready'] and not result['all_storage_remote']
    assert 'private-secret-invalid' not in json.dumps(result)


def test_remote_configuration_does_not_claim_migrations_or_hosted_acceptance(tmp_path):
    values={**environment(tmp_path),'US_PLAN_STORE':'supabase','US_RESEARCH_STORE':'supabase','US_JOB_STORE':'supabase'}
    with patch.dict(ready.os.environ,values,clear=True),patch.object(ready,'storage_probe') as probe:
        result=ready.report()
    assert result['configuration_ready'] and result['all_storage_remote']
    assert result['storage_probe']=='not_run'
    probe.assert_not_called()
    assert 'supabase_migrations_and_real_account_isolation' in result['unverified']
    assert 'remote_worker_coordination_and_crash_recovery' in result['unverified']


@pytest.mark.parametrize('check_storage',[False,True])
def test_fully_remote_configuration_needs_no_local_directory_and_never_probes_disk(tmp_path,check_storage):
    values={**environment(tmp_path),'US_PLAN_STORE':'supabase','US_RESEARCH_STORE':'supabase','US_JOB_STORE':'supabase'}
    values.pop('DATA_DIR')
    with patch.dict(ready.os.environ,values,clear=True),patch.object(ready,'storage_probe') as probe:
        result=ready.report(check_storage)
    assert result['configuration_ready'] and result['all_storage_remote']
    assert result['data_directory_required'] is False and result['absolute_data_directory'] is False
    assert result['checks']['data_directory_requirement_satisfied'] is True
    assert result['storage_probe']==('not_applicable_remote' if check_storage else 'not_run')
    probe.assert_not_called()
    assert 'supabase_migrations_and_real_account_isolation' in result['unverified']
    assert 'production_backups_and_restore' in result['unverified']


@pytest.mark.parametrize('modes',[
    {'US_PLAN_STORE':'sqlite','US_RESEARCH_STORE':'supabase','US_JOB_STORE':'supabase'},
    {'US_PLAN_STORE':'supabase','US_RESEARCH_STORE':'local','US_JOB_STORE':'local'},
    {'US_PLAN_STORE':'supabase','US_RESEARCH_STORE':'supabase','US_JOB_STORE':'local'},
])
def test_any_local_repository_still_requires_an_absolute_directory(tmp_path,modes):
    values={**environment(tmp_path),**modes};values.pop('DATA_DIR')
    with patch.dict(ready.os.environ,values,clear=True),patch.object(ready,'storage_probe') as probe:
        result=ready.report(True)
    assert not result['configuration_ready'] and result['data_directory_required']
    assert not result['checks']['data_directory_requirement_satisfied']
    assert result['storage_probe']=='failed'
    probe.assert_not_called()
