import json
from pathlib import Path
import pytest
from app.services.us_migration_review import NAMES,manifest


def sources(folder,newline=b'\n'):
    for name in NAMES:
        (folder/name).write_bytes(b'-- Synthetic review fixture'+newline+b'select 1;'+newline)


def test_manifest_is_ordered_read_only_and_does_not_claim_activation(tmp_path):
    sources(tmp_path)
    before={path.name:path.read_bytes() for path in tmp_path.iterdir()}
    result=manifest(tmp_path)
    assert [row['file'].split('/')[-1] for row in result['files']]==list(NAMES)
    assert result['migration_count']==6
    assert result['hosted_application']=='not_checked' and result['activation_approval_required']
    assert len(result['bundle_sha256'])==64
    assert {path.name:path.read_bytes() for path in tmp_path.iterdir()}==before
    assert str(tmp_path) not in json.dumps(result)


def test_windows_and_linux_checkout_text_have_the_same_fingerprint(tmp_path):
    sources(tmp_path,b'\r\n');windows=manifest(tmp_path)
    sources(tmp_path,b'\n');assert manifest(tmp_path)==windows


def test_sql_change_changes_file_and_bundle_fingerprint(tmp_path):
    sources(tmp_path);before=manifest(tmp_path)
    (tmp_path/NAMES[0]).write_text('select 2;\n',encoding='utf-8')
    after=manifest(tmp_path)
    assert after['bundle_sha256']!=before['bundle_sha256']
    assert after['files'][0]!=before['files'][0]
    assert after['files'][1:]==before['files'][1:]


@pytest.mark.parametrize('change',['missing','extra','empty'])
def test_unreviewed_inventory_fails_closed(tmp_path,change):
    sources(tmp_path)
    if change=='missing':(tmp_path/NAMES[0]).unlink()
    elif change=='extra':(tmp_path/'unexpected.sql').write_text('select 1;',encoding='utf-8')
    else:(tmp_path/NAMES[0]).write_text('',encoding='utf-8')
    with pytest.raises(ValueError):manifest(tmp_path)


def test_current_source_fingerprint_is_in_activation_review():
    root=Path(__file__).resolve().parents[2]
    assert manifest()['bundle_sha256'] in (root/'docs'/'SUPABASE-ACTIVATION-REVIEW.md').read_text(encoding='utf-8')
