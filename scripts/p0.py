#!/usr/bin/env python3
"""Small, resumable P0 driver. No remote writes, no real vault, no broad killall.
Commands: check-excerpts, check-fixed, check-delete-guard, prepare, audit, go-test, web. See docs/TECHNICAL_DESIGN.md §16.
"""
from __future__ import annotations
import argparse, hashlib, http.server, functools, json, os, re, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
REPO_URL='https://github.com/zakirullin/files.md.git'
UPSTREAM=ROOT/'upstream'
RESULTS=ROOT/'p0/results'
LOCK=ROOT/'p0/upstream.lock.json'

PATTERNS={
 'js_fs_sink':r'\.(?:createWritable|createSyncAccessHandle|removeEntry)\s*\(|\.(?:write|truncate|remove|move)\s*\(',
 'app_write_helper':r'\b(?:write|writeAtEnd|writeIfContentIsDifferent|saveTextFile|saveMessagesToChat|moveFile|moveCurrentFile|removeCurrentFile|addBacklink|rename|remove|removeDir|moveDir|writeMediaFile|syncCurrentFile|addHeaderAndText)\s*\(',
 'go_fs_sink':r'\b(?:os|afero)\.(?:WriteFile|Create|OpenFile|Rename|Remove|RemoveAll|Mkdir|MkdirAll)\s*\(|\.(?:Write|Append|Rename|Remove|RemoveAll|Truncate)\s*\(',
 'dynamic_code_review':r'\beval\s*\(|new\s+Function\s*\(',
}

def write_json(p:Path,value):
 p.parent.mkdir(parents=True,exist_ok=True)
 p.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')

def run(args:list[str],cwd:Path,log_name:str,env=None,timeout=240)->subprocess.CompletedProcess:
 RESULTS.mkdir(parents=True,exist_ok=True)
 print('+', ' '.join(args),flush=True)
 try:
  r=subprocess.run(args,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=timeout)
 except (OSError,subprocess.TimeoutExpired) as e:
  (RESULTS/log_name).write_text(f'NOT COMPLETED: {type(e).__name__}: {e}\n')
  raise RuntimeError(f'Command not completed. See {RESULTS/log_name}') from e
 (RESULTS/log_name).write_text(r.stdout)
 if r.returncode:
  print(r.stdout[-2000:],file=sys.stderr)
  raise RuntimeError(f'Command failed ({r.returncode}); log: {RESULTS/log_name}')
 return r

def prepare(commit:str|None=None, *, repo_url=REPO_URL, dest=UPSTREAM, lock=LOCK):
 if dest.exists():
  raise RuntimeError(f'Refusing to overwrite existing {dest}. Inspect it and the lock; no automatic reset/delete.')
 if commit and not re.fullmatch(r'[0-9a-fA-F]{40}',commit):
  raise RuntimeError('--commit must be an explicit full 40-character commit ID')
 dest.parent.mkdir(parents=True,exist_ok=True)
 run(['git','clone','--depth','1','--branch','main',repo_url,str(dest)],ROOT,'clone.log',timeout=180)
 if commit:
  run(['git','fetch','--depth','1','origin',commit],dest,'fetch.log',timeout=180)
  run(['git','checkout','--detach',commit],dest,'checkout.log')
 sha=run(['git','rev-parse','HEAD'],dest,'rev-parse.log').stdout.strip()
 if not re.fullmatch(r'[0-9a-f]{40}',sha): raise RuntimeError('Git did not return a full commit hash')
 if commit and sha.lower()!=commit.lower(): raise RuntimeError('Pinned commit mismatch')
 run(['git','switch','-c','xuye/p0-baseline'],dest,'branch.log')
 tracked=run(['git','ls-files','-z'],dest,'tracked-files.log').stdout.split('\0')
 hashes={}
 for name in tracked:
  if not name:continue
  p=dest/name
  # A hash inventory is not a source edit; avoid following symlinks out of checkout.
  if p.is_file() and not p.is_symlink(): hashes[name]=hashlib.sha256(p.read_bytes()).hexdigest()
 value={'repository':repo_url,'commit':sha,'retrieved_at_utc':datetime.now(timezone.utc).isoformat(),
        'branch':'xuye/p0-baseline','tree_sha256':hashes,'status':'pinned-checkout-not-tested'}
 write_json(lock,value)
 print(f'Pinned {sha}. No upstream application files modified. Run audit before enabling anything.')
 return value

def require_checkout():
 if not LOCK.is_file() or not (UPSTREAM/'.git').exists():
  raise RuntimeError('No verified checkout. Run prepare successfully first; excerpt tests are not a substitute.')
 value=json.loads(LOCK.read_text())
 sha=run(['git','rev-parse','HEAD'],UPSTREAM,'verify-head.log').stdout.strip()
 if sha!=value['commit']:raise RuntimeError('HEAD changed since pin; review before testing')
 run(['git','diff','--exit-code','HEAD','--','.'],UPSTREAM,'verify-tracked-diff.log')
 return value

def scan_paths(base:Path,names:list[str]):
 hits=[];scanned=[];skipped=[]
 for name in names:
  p=base/name
  if not name or p.suffix not in {'.go','.js','.mjs','.cjs','.ts','.tsx','.jsx'}:continue
  if name.startswith('vendor/') or p.is_symlink():
   skipped.append({'path':name,'reason':'vendored dependency or symlink'});continue
  if not p.is_file():
   skipped.append({'path':name,'reason':'not an available file'});continue
  text=p.read_text(encoding='utf8',errors='replace');scanned.append(name)
  context='(top-level or unresolved)'
  for line_num,line in enumerate(text.splitlines(),1):
   function=re.search(r'(?:async\s+)?function\s+([\w$]+)|func\s+(?:\([^)]*\)\s*)?(\w+)',line)
   if function:context=next(x for x in function.groups() if x)
   if line.lstrip().startswith('//'):continue
   for category,pattern in PATTERNS.items():
    if category=='go_fs_sink' and p.suffix!='.go':continue
    if category=='js_fs_sink' and p.suffix=='.go':continue
    if re.search(pattern,line):hits.append({'file':name,'line':line_num,'category':category,'nearest_function_heuristic':context,
        'test_code':name.startswith('tests/') or name.endswith('_test.go'),'snippet':line.strip()[:600]})
 return {'scope':'lexical review candidates, NOT a complete call graph or proof of no bypasses',
         'scanned_files':scanned,'skipped_files':skipped,'candidates':hits}

def audit():
 pin=require_checkout()
 names=run(['git','ls-files','-z'],UPSTREAM,'audit-tracked.log').stdout.split('\0')
 result=scan_paths(UPSTREAM,names);result['commit']=pin['commit']
 write_json(RESULTS/'write-path-candidates.json',result)
 print(f"Scanned {len(result['scanned_files'])} code files; {len(result['candidates'])} review candidates. Not an exhaustive audit verdict.")

def go_test():
 pin=require_checkout();env=os.environ.copy()
 for key in ['BOT_API_TOKEN','TOKENS_SALT','TOKENS_DIR','STORAGE_DIR','CERT_DIR','LOG_FILE','APP_URL','API_URL']:
  env.pop(key,None)
 # Tests run in isolated checkout; no real user credential or vault is supplied.
 env['BOT_API_TOKEN']='';env['GOTOOLCHAIN']='local'
 record={'commit':pin['commit'],'command':['go','test','-json','./...'],'status':'started'}
 write_json(RESULTS/'upstream-go-status.json',record)
 try:
  run(record['command'],UPSTREAM,'upstream-go.jsonl',env=env,timeout=600)
  record['status']='command-succeeded'
 except Exception as e:
  record['status']='failed-or-blocked';record['error']=str(e);raise
 finally:write_json(RESULTS/'upstream-go-status.json',record)



def check_excerpts():
 # This intentionally requires no network, upstream checkout, model, or real vault.
 env=os.environ.copy()
 env.update({'GOTOOLCHAIN':'local','GOPROXY':'off','GOSUMDB':'off',
             'PYTHONDONTWRITEBYTECODE':'1'})
 commands=[
  ('node-helper-characterization',['node','--test',str(ROOT/'p0/tests/fs_excerpt.test.cjs')],ROOT,'node-excerpt.tap'),
  ('go-lcs-core-characterization',['go','test','-count=1','-v','.'],ROOT/'p0/tests/mergecore','go-mergecore.log'),
  ('driver-self-checks',[sys.executable,str(ROOT/'p0/tests/driver_test.py')],ROOT,'driver-tests.log'),
 ]
 report={'scope':'excerpt/helper characterization and harness self-checks; NOT upstream or product acceptance',
         'completed_at_utc':None,'results':[]}
 for name,args,cwd,log in commands:
  item={'name':name,'command':args,'log':log}
  try:
   run(args,cwd,log,env=env,timeout=120)
   item['status']='expected-assertions-confirmed'
  except RuntimeError as e:
   item.update({'status':'failed-or-blocked','error':str(e)})
  report['results'].append(item)
 report['completed_at_utc']=datetime.now(timezone.utc).isoformat()
 write_json(RESULTS/'local-checks.json',report)
 if any(x['status']!='expected-assertions-confirmed' for x in report['results']):
  raise RuntimeError('Some local checks failed or were blocked; see local-checks.json')
 print('Expected characterization assertions confirmed. Unsafe edge cases remain; no P0 or S01-S28 acceptance claim.')


def main():
 a=argparse.ArgumentParser(description=__doc__)
 a.add_argument('command',choices=['check-excerpts','check-fixed','check-delete-guard','prepare','audit','go-test','web'])
 a.add_argument('--commit');a.add_argument('--port',type=int,default=3000)
 args=a.parse_args()
 try:
  if args.command=='check-excerpts':check_excerpts()
  elif args.command=='check-fixed':
   subprocess.run([sys.executable,'-S',str(ROOT/'scripts/verify_pinned.py')],cwd=ROOT,check=True)
  elif args.command=='check-delete-guard':
   subprocess.run([sys.executable,'-S',str(ROOT/'scripts/verify_delete_guard.py')],cwd=ROOT,check=True)
  elif args.command=='prepare':
   target_file=ROOT/'p0/upstream-target.json'
   target=json.loads(target_file.read_text())['commit'] if target_file.exists() else None
   prepare(args.commit or target)
  elif args.command=='audit':audit()
  elif args.command=='go-test':go_test()
  else:
   require_checkout()
   # Only static local UI; no Go sync server, bot, model, or public deployment.
   server=http.server.ThreadingHTTPServer(('127.0.0.1',args.port),functools.partial(http.server.SimpleHTTPRequestHandler,directory=UPSTREAM/'web'))
   print(f'Serving isolated upstream UI on http://127.0.0.1:{args.port}; Ctrl+C stops this process. Use a test folder only.',flush=True)
   try:server.serve_forever()
   finally:server.server_close()
 except KeyboardInterrupt:return 130
 except Exception as e:print(str(e),file=sys.stderr);return 1
 return 0
if __name__=='__main__':sys.exit(main())
