#!/usr/bin/env python3
"""Write fresh structured evidence from development tool unit tests."""
import json
import os
import sys
import unittest
from pathlib import Path

repository = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(repository/'scripts'))
sys.path.insert(0,str(repository/'scripts/native'))
from test_support import fingerprint

class EvidenceResult(unittest.TextTestResult):
 def __init__(self,*arguments,**options):
  super().__init__(*arguments,**options)
  self.scenarios=[]
 def addSuccess(self,test):
  super().addSuccess(test)
  self.scenarios.append({'name':test._testMethodName,'status':'pass'})
 def addFailure(self,test,error):
  super().addFailure(test,error)
  self.scenarios.append({'name':test._testMethodName,'status':'fail'})
 def addError(self,test,error):
  super().addError(test,error)
  self.scenarios.append({'name':test._testMethodName,'status':'fail'})
 def addSkip(self,test,reason):
  super().addSkip(test,reason)
  self.scenarios.append({'name':test._testMethodName,'status':'skipped','reason':reason})

suite=unittest.defaultTestLoader.discover(str(repository/'scripts/tests'),pattern='test_*.py')
suite.addTests(unittest.defaultTestLoader.discover(str(repository/'scripts/native'),pattern='test_performance_guard.py'))
suite.addTests(unittest.defaultTestLoader.discover(str(repository/'scripts/native'),pattern='test_verify_package.py'))
suite.addTests(unittest.defaultTestLoader.discover(str(repository/'scripts/native'),pattern='test_http_process_cleanup.py'))
suite.addTests(unittest.defaultTestLoader.discover(str(repository/'scripts/native'),pattern='test_native_cleanup.py'))
suite.addTests(unittest.defaultTestLoader.discover(str(repository/'scripts/native'),pattern='test_progress_checkpoint.py'))
suite.addTests(unittest.defaultTestLoader.discover(str(repository/'scripts/native'),pattern='test_http_transport.py'))
suite.addTests(unittest.defaultTestLoader.discover(str(repository/'scripts/native'),pattern='test_pending_delete_public.py'))
suite.addTests(unittest.defaultTestLoader.discover(str(repository/'scripts/native'),pattern='test_public_composition.py'))
suite.addTests(unittest.defaultTestLoader.discover(str(repository/'scripts/native'),pattern='test_qualification_contract.py'))
result=unittest.TextTestRunner(verbosity=2,resultclass=EvidenceResult).run(suite)
exit_status=0 if result.wasSuccessful() and result.testsRun>=7 and not result.skipped else 1
report=repository/'.local/test-results/acceptance-boundary.json'
report.parent.mkdir(parents=True,exist_ok=True)
report.write_text(json.dumps({'fingerprint':os.environ.get('SYNLOQUENT_CANDIDATE_FINGERPRINT',fingerprint()),'exitStatus':exit_status,'scenarios':result.scenarios},indent=2)+'\n')
raise SystemExit(exit_status)
