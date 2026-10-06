#!/usr/bin/env python3
"""Execute the package against the exact read-only reference Laravel major."""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from test_support import fingerprint, validate_report, utc_time

repository = Path(__file__).resolve().parents[1]
artifacts = repository / '.local/test-results/compatibility'
artifacts.mkdir(parents=True, exist_ok=True)
consumer = artifacts / 'laravel-12.55.1'
consumer.mkdir(exist_ok=True)
metadata = {'name':'synloquent/laravel12-compatibility-consumer','require':{'synloquent/laravel':'0.1.0','laravel/framework':'12.55.1'},'require-dev':{'orchestra/testbench':'10.8.0','orchestra/testbench-core':'10.8.0','orchestra/workbench':'10.0.7','phpunit/phpunit':'^11.5'},'repositories':[{'type':'path','url':str(repository/'packages/laravel'),'options':{'symlink':True}}],'autoload-dev':{'psr-4':{'Synloquent\\Tests\\':str(repository/'packages/laravel/tests')+'/', 'App\\':str(repository/'examples/laravel/app')+'/'}} ,'config':{'allow-plugins':{}}}
manifest = consumer / 'composer.json'
content = json.dumps(metadata,indent=2)+'\n'
metadata_changed=not manifest.exists() or manifest.read_text()!=content
if metadata_changed:
 manifest.write_text(content)
install = ['composer','install' if (consumer/'composer.lock').exists() and not metadata_changed else 'update','--no-interaction','--prefer-dist','--no-scripts']
started=utc_time()
with (artifacts/'install.log').open('w') as log:
 subprocess.run(install,cwd=consumer,stdout=log,stderr=subprocess.STDOUT,check=True)
locked=json.loads((consumer/'composer.lock').read_text())
framework=next(package for package in locked['packages'] if package['name']=='laravel/framework')
if framework['version']!='v12.55.1':raise RuntimeError('Compatibility consumer resolved the wrong framework')
configuration=consumer/'phpunit.xml'
configuration.write_text('<?xml version="1.0" encoding="UTF-8"?><phpunit bootstrap="vendor/autoload.php" failOnRisky="true" failOnWarning="true" failOnEmptyTestSuite="true"><testsuites><testsuite name="Laravel12 compatibility"><directory>'+str(repository/'packages/laravel/tests')+'</directory></testsuite></testsuites></phpunit>\n')
database='synloquent_compatibility_'+str(os.getpid())
postgres=(os.environ.get('SYNLOQUENT_POSTGRES_BIN', '').rstrip('/') + '/' if os.environ.get('SYNLOQUENT_POSTGRES_BIN') else '')
connection=['-h','127.0.0.1','-p','55432','-U','synloquent',database]
subprocess.run([postgres+'createdb',*connection],check=True)
report=artifacts/'laravel12.xml'
report.unlink(missing_ok=True)
command=[str(consumer/'vendor/bin/phpunit'),'--configuration',str(configuration),'--log-junit',str(report)]
environment={**os.environ,'SYNLOQUENT_TEST_DATABASE':database,'SYNLOQUENT_TEST_AUTOLOAD':str(consumer/'vendor/autoload.php')}
try:
 with (artifacts/'tests.log').open('w') as log:
  result=subprocess.run(command,cwd=repository/'packages/laravel',env=environment,stdout=log,stderr=subprocess.STDOUT,check=False)
 if result.returncode:raise RuntimeError('Laravel12 compatibility tests failed, inspect '+str(artifacts/'tests.log'))
 evidence=validate_report(report,'phpunit-junit',[],fingerprint())
 (artifacts/'result.json').write_text(json.dumps({'fingerprint':fingerprint(),'startedAt':started,'finishedAt':utc_time(),'command':command,'exitStatus':result.returncode,'framework':framework['version'],'report':str(report),'testEvidence':evidence},indent=2)+'\n')
 print('Laravel12.55.1 compatibility passed '+str(evidence['count'])+' actual tests')
finally:
 subprocess.run([postgres+'dropdb','--if-exists','--force',*connection],check=True)
