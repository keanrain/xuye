/* Node helper characterization, not browser OPFS or whole-app E2E.
 * Uses a TEST-ONLY FileSystemHandle adapter backed by disposable disk files.
 * Browser semantics are approximated; no browser persistence claim is made.
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {File}=require('node:buffer');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const SOURCE=process.env.XUYE_FS_SOURCE ? path.resolve(process.env.XUYE_FS_SOURCE) : path.resolve(__dirname,'../sources/filesmd-fs-excerpt.js');

async function harness(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'xuye-p0-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  function part(name){
    if(!name || ['.','..'].includes(name) || /[\\/]/.test(name)) throw new Error('invalid test-adapter path component');
    return name;
  }
  function notFound(e){if(e.code==='ENOENT') e.name='NotFoundError';throw e;}
  function fileHandle(full){return {
    name:path.basename(full),kind:'file',
    async getFile(){try{return new File([await fs.readFile(full)],path.basename(full));}catch(e){notFound(e)}},
    async createWritable(options={}){
      let data=options.keepExistingData?await fs.readFile(full):Buffer.alloc(0);
      let pos=0;
      return {
        async seek(n){pos=n},
        async write(content){
          const x=typeof content==='string'?Buffer.from(content):Buffer.from(await content.arrayBuffer());
          const next=Buffer.alloc(Math.max(data.length,pos+x.length));data.copy(next);x.copy(next,pos);data=next;pos+=x.length;
        },
        async close(){await fs.writeFile(full,data)}
      };
    },
    async remove(){await fs.unlink(full)}
  }}
  function dirHandle(full){return {
    name:path.basename(full),kind:'directory',
    async getDirectoryHandle(name,opts={}){
      const p=path.join(full,part(name));
      try{if(opts.create)await fs.mkdir(p,{recursive:true});await fs.access(p)}catch(e){notFound(e)}
      return dirHandle(p);
    },
    async getFileHandle(name,opts={}){
      const p=path.join(full,part(name));
      try{if(opts.create){const h=await fs.open(p,'a');await h.close()}await fs.access(p)}catch(e){notFound(e)}
      return fileHandle(p);
    }
  }}
  const ctx=vm.createContext({getRootDirHandle:async()=>dirHandle(root),log:()=>{},logError:()=>{},removeMemFile:()=>{}});
  vm.runInContext(await fs.readFile(SOURCE,'utf8'),ctx,{filename:SOURCE});
  ctx.isContentEqual=async(p,c)=>(await ctx.read(p))===c;
  return {ctx,root};
}

test('ordinary UTF-8, CRLF, emoji round-trip via helper + disk adapter',async t=>{
 const {ctx,root}=await harness(t);const text='# 实验\r\n中文🙂é\r\n';
 await ctx.write('/notes/实验.md',text);
 assert.equal(await ctx.read('/notes/实验.md'),text);
 assert.deepEqual(await fs.readFile(path.join(root,'notes/实验.md')),Buffer.from(text));
});
test('append preserves existing multibyte content in test adapter',async t=>{
 const {ctx}=await harness(t);await ctx.write('append.md','中文🙂');await ctx.writeAtEnd('append.md',' next');
 assert.equal(await ctx.read('append.md'),'中文🙂 next');
});
test('rename/move to new path preserves ordinary bytes',async t=>{
 const {ctx}=await harness(t);await ctx.write('a.md','note\r\n');await ctx.rename('a.md','notes/b.md');
 assert.equal(await ctx.exists('a.md'),false);assert.equal(await ctx.read('notes/b.md'),'note\r\n');
});
test('RISK REPRO: helper rename overwrites an existing target (UI not exercised)',async t=>{
 const {ctx}=await harness(t);await ctx.write('a.md','source');await ctx.write('b.md','valuable target');await ctx.rename('a.md','b.md');
 assert.equal(await ctx.read('b.md'),'source');assert.equal(await ctx.exists('a.md'),false);
});
test('FAULT REPRO: failure between copy and removal leaves both files',async t=>{
 const {ctx}=await harness(t);await ctx.write('a.md','original');const remove=ctx.remove;
 ctx.remove=async()=>{throw new Error('injected remove failure')};
 await assert.rejects(ctx.rename('a.md','b.md'),/injected/);ctx.remove=remove;
 assert.equal(await ctx.read('a.md'),'original');assert.equal(await ctx.read('b.md'),'original');
});
test('RISK REPRO: text roundtrip rename strips UTF-8 BOM in Node File adapter',async t=>{
 const {ctx,root}=await harness(t);const before=Buffer.from('\ufeff# note\r\n中文');
 await fs.writeFile(path.join(root,'a.md'),before);await ctx.rename('a.md','b.md');
 assert.deepEqual(await fs.readFile(path.join(root,'b.md')),before.subarray(3));
});
test('save failure propagates rather than returning success',async t=>{
 const {ctx}=await harness(t);ctx.getFileHandle=async()=>({createWritable:async()=>({write:async()=>{},close:async()=>{throw new Error('injected disk failure')}})});
 await assert.rejects(ctx.write('a.md','text'),/injected disk failure/);
});
test('delete removes a disposable file',async t=>{
 const {ctx}=await harness(t);await ctx.write('a.md','remove fixture');await ctx.remove('a.md');assert.equal(await ctx.exists('a.md'),false);
});
test('saved bytes readable by a separate Node process (not browser restart)',async t=>{
 const {ctx,root}=await harness(t);await ctx.write('a.md','persistent disk fixture');
 const {stdout}=await promisify(execFile)(process.execPath,['-e','process.stdout.write(require("node:fs").readFileSync(process.argv[1]))',path.join(root,'a.md')]);
 assert.equal(stdout,'persistent disk fixture');
});
