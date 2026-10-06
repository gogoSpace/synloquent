#!/usr/bin/env python3
"""Qualify actual PostgreSQL process barriers from named PHPUnit witnesses."""
import argparse
import json
import os
import subprocess
import xml.etree.ElementTree as ElementTree
from pathlib import Path
from test_support import fingerprint, utc_time, validate_report

repository=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--snapshot',action='store_true')
arguments=parser.parse_args()
scenarios={
 'snapshot-lock-first':'test_snapshot_waits_for_stream_lock_before_domain_read',
 'immutable-snapshot-tail':'test_snapshot_anchor_retains_writes_committed_after_materialization',
} if arguments.snapshot else {
 'commit-order':'test_independent_connections_block_before_mutation_and_publish_in_commit_order',
 'rollback-after-kill':'test_process_kill_before_commit_rolls_back_all_captured_state',
 'idempotent-effect-recovery':'test_external_success_then_worker_death_uses_downstream_idempotency',
}
artifacts=repository/'.local/test-results'
artifacts.mkdir(parents=True,exist_ok=True)
name='snapshot-concurrency' if arguments.snapshot else 'concurrency'
report=artifacts/(name+'.xml')
report.unlink(missing_ok=True)
command=[str(repository/'packages/laravel/vendor/bin/phpunit'),'--filter','|'.join(scenarios.values()),'--log-junit',str(report)]
database='synloquent_'+name.replace('-','_')+'_'+str(os.getpid())
connection=['-h','127.0.0.1','-p','55432','-U','synloquent',database]
postgres=(os.environ.get('SYNLOQUENT_POSTGRES_BIN', '').rstrip('/') + '/' if os.environ.get('SYNLOQUENT_POSTGRES_BIN') else '')
subprocess.run([postgres+'createdb',*connection],check=True)
started=utc_time()
try:
 with (artifacts/(name+'.log')).open('w') as log:
  completed=subprocess.run(command,cwd=repository/'packages/laravel',env={**os.environ,'SYNLOQUENT_TEST_DATABASE':database},stdout=log,stderr=subprocess.STDOUT,check=False)
 candidate=os.environ.get('SYNLOQUENT_CANDIDATE_FINGERPRINT',fingerprint())
 evidence=validate_report(report,'phpunit-junit',list(scenarios.values()),candidate) if completed.returncode==0 else None
 cases=list(ElementTree.parse(report).getroot().iter('testcase')) if report.is_file() else []
 passed={case.get('name') for case in cases if not list(case.iter('failure')) and not list(case.iter('error')) and not list(case.iter('skipped'))}
 exit_status=completed.returncode if completed.returncode else 0 if evidence else 1
 outcomes=[{'name':name,'status':'pass' if testcase in passed and exit_status==0 else 'fail','testcase':testcase,'report':str(report)} for name,testcase in scenarios.items()]
 (artifacts/(name+'.json')).write_text(json.dumps({'fingerprint':candidate,'exitStatus':exit_status,'startedAt':started,'finishedAt':utc_time(),'command':command,'testEvidence':evidence,'scenarios':outcomes},indent=2)+'\n')
 if exit_status:raise SystemExit(exit_status)
 print('Real PostgreSQL process scenarios passed: '+', '.join(scenarios))
finally:
 subprocess.run([postgres+'dropdb','--if-exists','--force',*connection],check=True)
