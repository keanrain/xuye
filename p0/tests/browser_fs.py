#!/usr/bin/env python3
"""Execute the documented Files.md fs helper excerpt against real Chromium OPFS.
Not the original app, not a pinned checkout, not Tauri/mobile acceptance.
Only an isolated localhost origin and a disposable browser profile are used.
"""
from __future__ import annotations
import argparse, functools, http.server, json, os, shutil, sys, tempfile, threading, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', default=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'))
    parser.add_argument('--result', type=Path, default=ROOT/'p0/results/browser-fs.json')
    args = parser.parse_args()
    if not args.browser:
        print('Set CHROMIUM_PATH to a Chromium executable.', file=sys.stderr)
        return 2
    report = {'scope': 'web-transcribed helper excerpt with actual Chromium OPFS; not upstream E2E', 'checks': []}
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=ROOT/'p0/sources'))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{server.server_port}'
    def record(name, ok, detail, category='baseline'):
        row={'name':name, 'ok':bool(ok), 'category':category, 'detail':detail}
        report['checks'].append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    try:
        with tempfile.TemporaryDirectory(prefix='xuye-p0-profile-') as profile, sync_playwright() as p:
            def launch():
                ctx=p.chromium.launch_persistent_context(profile, executable_path=args.browser, headless=True, args=['--no-sandbox','--disable-dev-shm-usage'])
                ctx.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin+'/') else route.abort())
                page=ctx.pages[0] if ctx.pages else ctx.new_page()
                page.goto(origin+'/index.html', wait_until='load')
                page.wait_for_function('typeof read === "function"')
                return ctx,page
            ctx,page=launch()
            report['browser']=ctx.browser.version if ctx.browser else 'persistent Chromium'
            try:
                value=page.evaluate('''async()=>{
                  const text='# 实验\\r\\n中文 🙂 é\\r\\n未知字段原样保留\\r\\n';
                  await write('/notes/实验.md',text);
                  return {expected:text,actual:await read('/notes/实验.md')};
                }''')
                record('UTF-8/CRLF/emoji round trip', value['expected']==value['actual'], value)
                value=page.evaluate('''async()=>{
                  await write('/append.md','中文🙂');
                  await writeAtEnd('/append.md',' + next');
                  return await read('/append.md');
                }''')
                record('append uses byte offset',value=='中文🙂 + next',value)
                value=page.evaluate('''async()=>{
                  await write('/old.md','original');
                  await rename('/old.md','/nested/new.md');
                  return {old:await exists('/old.md'),current:await read('/nested/new.md')};
                }''')
                record('successful helper rename/move',not value['old'] and value['current']=='original',value)
                value=page.evaluate('''async()=>{
                  await write('/from.md','source');await write('/to.md','destination');
                  await rename('/from.md','/to.md');
                  return {old:await exists('/from.md'),new:await read('/to.md')};
                }''')
                record('reproduced: existing destination overwritten by helper',not value['old'] and value['new']=='source',value,'observed-risk—not-safety-pass')
                value=page.evaluate('''async()=>{
                  await write('/partial-old.md','both survive');
                  const original=remove; let error='';
                  remove=async()=>{throw new Error('injected remove failure');};
                  try{await rename('/partial-old.md','/partial-new.md');}catch(e){error=e.message;}finally{remove=original;}
                  return {error,old:await read('/partial-old.md'),new:await read('/partial-new.md')};
                }''')
                record('reproduced: failure after copy leaves both files',value['error']=='injected remove failure' and value['old']==value['new']=='both survive',value,'fault-injection—not-crash-recovery-test')
                value=page.evaluate('''async()=>{
                  await write('/bom-old.md','\\ufeff# BOM\\r\\n正文\\r\\n');
                  const before=Array.from(new Uint8Array(await (await getFileHandle('/bom-old.md')).getFile().then(f=>f.arrayBuffer())));
                  await rename('/bom-old.md','/bom-new.md');
                  const after=Array.from(new Uint8Array(await (await getFileHandle('/bom-new.md')).getFile().then(f=>f.arrayBuffer())));
                  return {before,after};
                }''')
                record('reproduced: BOM lost on read-text/write-text rename',value['before'][:3]==[239,187,191] and value['after']==value['before'][3:],value,'observed-byte-change')
                value=page.evaluate('''async()=>{
                  await write('/remove.md','delete fixture');await remove('/remove.md');
                  return {present:await exists('/remove.md')};
                }''')
                record('delete helper',not value['present'],value)
                page.reload(wait_until='load')
                value=page.evaluate("async()=>await read('/notes/实验.md')")
                record('OPFS survives page reload',value.startswith('# 实验\r\n'),value)
            finally:
                ctx.close()
            ctx,page=launch()
            try:
                value=page.evaluate("async()=>await read('/notes/实验.md')")
                record('OPFS survives browser close/reopen',value.startswith('# 实验\r\n'),value)
            finally:
                ctx.close()
    except Exception as exc:
        report['fatal_error']=f'{type(exc).__name__}: {exc}'
        print(report['fatal_error'],file=sys.stderr)
    finally:
        server.shutdown();server.server_close()
        report['observations_confirmed']=sum(x['ok'] for x in report['checks'])
        report['observation_count']=len(report['checks'])
        report['all_expected_observations']=bool(report['checks']) and all(x['ok'] for x in report['checks']) and 'fatal_error' not in report
        args.result.parent.mkdir(parents=True,exist_ok=True)
        args.result.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return 0 if report['all_expected_observations'] else 1
if __name__=='__main__':sys.exit(main())
