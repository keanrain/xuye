#!/usr/bin/env python3
"""Verify fixed-ref source material and rerun isolated call-chain observations.
This is NOT a complete checkout, an upstream test run, or browser acceptance.
"""
from __future__ import annotations
import argparse,hashlib,json,os,subprocess,sys
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
TARGET=ROOT/'p0/upstream-target.json'
OUT=ROOT/'p0/results/github-pinned'

def verify():
 data=json.loads(TARGET.read_text());checks=[]
 for entry in data['blobs']:
  p=ROOT/entry['local_path'];blob=p.read_bytes()
  if hashlib.sha256(blob).hexdigest()!=entry['sha256']:raise RuntimeError(f'Local source changed: {p}')
  if entry['kind']=='full-blob':
   got=hashlib.sha1(b'blob '+str(len(blob)).encode()+b'\0'+blob).hexdigest()
   if got!=entry['git_blob_sha']:raise RuntimeError(f'Git blob mismatch: {p}')
  checks.append({'path':entry['local_path'],'kind':entry['kind'],'verified':True})
 return data,checks

def run_case(name,args,env,expected,cwd=ROOT):
 try:
  cp=subprocess.run(args,cwd=cwd,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60)
  (OUT/name).write_text(cp.stdout)
  return {'log':name,'exit_code':cp.returncode,'expected_exit':expected,'expectation_matched':cp.returncode==expected}
 except (OSError,subprocess.TimeoutExpired) as e:
  (OUT/name).write_text(f'BLOCKED: {type(e).__name__}: {e}\n')
  return {'log':name,'blocked':str(e),'expectation_matched':False}

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--verify-only',action='store_true');args=p.parse_args()
 OUT.mkdir(parents=True,exist_ok=True)
 try:
  target,checks=verify()
  report={'commit':target['commit'],'source_checks':checks,'executed_at_utc':datetime.now(timezone.utc).isoformat(),'tests':[],
   'scope':'fixed source functions + test-only disk seams. Red failures are expected; green candidate does not pass all product requirements.'}
  if not args.verify_only:
   env=os.environ.copy()
   for key in ['XUYE_MOVE_CANDIDATE','XUYE_REQUIRE_SOURCE_SURVIVAL','XUYE_FS_SOURCE']:env.pop(key,None)
   run=['node','--test',str(ROOT/'p0/tests/pinned-callchains.test.cjs')]
   report['tests'].append(run_case('callchains-baseline.tap',run,env,0))
   report['tests'].append(run_case('callchains-regression-red.tap',run,{**env,'XUYE_REQUIRE_SOURCE_SURVIVAL':'1'},1))
   report['tests'].append(run_case('callchains-candidate-green.tap',run,{**env,'XUYE_REQUIRE_SOURCE_SURVIVAL':'1','XUYE_MOVE_CANDIDATE':'1'},0))
   report['tests'].append(run_case('helpers-pinned.tap',['node','--test',str(ROOT/'p0/tests/fs_excerpt.test.cjs')],{**env,'XUYE_FS_SOURCE':str(ROOT/'p0/pinned/9e948ba/web/lib/fs.js')},0))
  (OUT/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
  print(json.dumps({'commit':report['commit'],'verified_full_blobs':sum(x['kind']=='full-blob' for x in checks),'range_materials':sum(x['kind']!='full-blob' for x in checks),'test_runs':report['tests']},ensure_ascii=False,indent=2))
  return 0 if all(x['expectation_matched'] for x in report['tests']) else 1
 except Exception as e:print(str(e),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
