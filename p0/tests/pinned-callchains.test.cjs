/** Fixed GitHub commit function-level integration with TEST-ONLY disk/DOM seams.
 * Full fs.js is Git-blob verified. files.js functions are exact selected ranges.
 * No browser API, live server, real vault, or application UI is exercised.
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {File}=require('node:buffer');
const {createHash}=require('node:crypto');
const PIN=path.resolve(__dirname,'../pinned/9e948ba');
const MODE=process.env.XUYE_MOVE_CANDIDATE==='1';
const STRICT=process.env.XUYE_REQUIRE_SOURCE_SURVIVAL==='1';

function gitBlob(b){return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');}
async function setup(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'xuye-fixed-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const faults={writePath:null,removePath:null};const logs=[];const mem={};
 const valid=n=>{if(!n||n==='.'||n==='..'||/[\\/]/.test(n))throw new Error('invalid adapter component');return n;};
 const relative=f=>'/'+path.relative(root,f).split(path.sep).join('/');
 const readFsError=e=>{if(e.code==='ENOENT')e.name='NotFoundError';throw e;};
 function at(p){return path.join(root,...p.split('/').filter(Boolean).map(valid));}
 function getMem(p){return p.split('/').filter(Boolean).reduce((obj,part,i,parts)=>obj?.[part+(i===parts.length-1?'':'/')],mem)||null;}
 function addMem(p,value){const parts=p.split('/').filter(Boolean);const leaf=parts.pop();let cur=mem;for(const part of parts)cur=cur[part+'/']||=( {} );cur[leaf]=value;}
 function dropMem(p){const parts=p.split('/').filter(Boolean);const leaf=parts.pop();let cur=mem;for(const part of parts){cur=cur[part+'/'];if(!cur)return;}delete cur[leaf];}
 function walk(obj,callback,p='/'){for(const [k,v] of Object.entries(obj)){if(v.isFile)callback(p+k,true);else{callback(p+k,false);walk(v,callback,p+k);}}}
 function fh(full){return {name:path.basename(full),kind:'file',
  async getFile(){try{return new File([await fs.readFile(full)],path.basename(full));}catch(e){readFsError(e);}},
  async createWritable(opts={}){
   let buf=opts.keepExistingData?await fs.readFile(full):Buffer.alloc(0);let offset=0;
   return {async seek(n){offset=n;},async write(x){const b=typeof x==='string'?Buffer.from(x):Buffer.from(await x.arrayBuffer());const next=Buffer.alloc(Math.max(buf.length,offset+b.length));buf.copy(next);b.copy(next,offset);buf=next;offset+=b.length;},
    async close(){if(relative(full)===faults.writePath)throw new Error('INJECTED_WRITE_FAILURE');await fs.writeFile(full,buf);}};
  },
  async remove(){if(relative(full)===faults.removePath)throw new Error('INJECTED_REMOVE_FAILURE');await fs.unlink(full);}
 };}
 function dh(full){return {
  async getDirectoryHandle(n,opts={}){const f=path.join(full,valid(n));try{if(opts.create)await fs.mkdir(f,{recursive:true});await fs.access(f);}catch(e){readFsError(e);}return dh(f);},
  async getFileHandle(n,opts={}){const f=path.join(full,valid(n));try{if(opts.create){const h=await fs.open(f,'a');await h.close();}await fs.access(f);}catch(e){readFsError(e);}return fh(f);},
  async removeEntry(n,opts={}){const f=path.join(full,valid(n));logs.push(['removeEntry',relative(f),opts]);await fs.rm(f,{recursive:!!opts.recursive,force:false});}
 };}
 const ctx=vm.createContext({files:mem,getRootDirHandle:async()=>dh(root),log:(...x)=>logs.push(['log',...x]),logError:(...x)=>logs.push(['error',...x]),removeMemFile:dropMem,addMemFile:addMem,getMemFile:getMem,
  walk,trimPrefix:(s,p)=>s.startsWith(p)?s.slice(p.length):s,joinPath:(...p)=>path.posix.join(...p),renderSidebar:async()=>{},
  toFilename:p=>path.posix.basename(p),isMediaPath:p=>/\.(png|jpg|mp4)$/i.test(p),LOG_PATH:'/log.md',editor:{path:'/other.md'},editor2:{path:'/other2.md'},server:{files:{}},
  console:{warn:(...x)=>logs.push(['warn',...x])},alert:(x)=>logs.push(['alert',x]),localStorage:{removeItem:()=>{}}
 });
 const full=await fs.readFile(path.join(PIN,'web/lib/fs.js'));
 assert.equal(gitBlob(full),'16e853ae2096dda936d7006619fe9d12c0d09493');
 vm.runInContext(full.toString(),ctx,{filename:'pinned/web/lib/fs.js'});
 let move=await fs.readFile(path.join(PIN,'web/moveFile.function.js'),'utf8');
 if(MODE){const old="        logError('Error moving file:', error);\n";assert.equal(move.split(old).length,2);move=move.replace(old,old+'        throw error;\n');}
 vm.runInContext(move,ctx,{filename:MODE?'candidate/moveFile.function.js':'pinned/moveFile.function.js'});
 vm.runInContext(await fs.readFile(path.join(PIN,'web/collectModifiedAndDeletedFiles.function.js'),'utf8'),ctx,{filename:'pinned/collectModifiedAndDeletedFiles.function.js'});
 ctx.isContentEqual=async(p,c)=>(await ctx.read(p))===c;
 async function seed(p,content){await ctx.write(p,content);addMem(p,{isFile:true,path:p,handle:await ctx.getFileHandle(p)});}
 async function readOrNull(p){try{return await fs.readFile(at(p),'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 return {ctx,root,faults,logs,seed,readOrNull};
}

test('fixed fs.js Git blob verified before every call-chain test',async t=>{const h=await setup(t);assert.ok(h.ctx.moveDir);});
test('successful directory move preserves both files',async t=>{const h=await setup(t);await h.seed('/from/a.md','A');await h.seed('/from/b.md','B');await h.ctx.moveDir('/from','/to');assert.equal(await h.readOrNull('/to/a.md'),'A');assert.equal(await h.readOrNull('/to/b.md'),'B');assert.equal(await h.readOrNull('/from/a.md'),null);});
test('injected target-write failure: inspect original source survival',async t=>{
 const h=await setup(t);await h.seed('/from/a.md','ONLY ORIGINAL');h.faults.writePath='/to/a.md';await h.ctx.moveDir('/from','/to');
 const source=await h.readOrNull('/from/a.md');const target=await h.readOrNull('/to/a.md');
 t.diagnostic(JSON.stringify({candidate:MODE,source,target,recursiveOldDelete:h.logs.some(x=>x[0]==='removeEntry'&&x[1]==='/from')}));
 if(STRICT||MODE)assert.equal(source,'ONLY ORIGINAL','failed target write must not cause deletion of the only original');
 else{assert.equal(source,null);assert.equal(target,'');}
});
test('one of two files fails: identify loss vs retained failed file',async t=>{
 const h=await setup(t);await h.seed('/from/a.md','A');await h.seed('/from/b.md','B');h.faults.writePath='/to/b.md';await h.ctx.moveDir('/from','/to');
 assert.equal(await h.readOrNull('/to/a.md'),'A');
 const source=await h.readOrNull('/from/b.md');t.diagnostic(JSON.stringify({candidate:MODE,remainingFailedSource:source}));
 if(STRICT||MODE)assert.equal(source,'B');else assert.equal(source,null);
});
test('move into own descendant is refused without deletion',async t=>{
 const h=await setup(t);await h.seed('/from/a.md','KEEP');await h.ctx.moveDir('/from','/from/inner');assert.equal(await h.readOrNull('/from/a.md'),'KEEP');assert.equal(await h.readOrNull('/from/inner/a.md'),null);
});
test('sync classifier: existing file with status error becomes deletion candidate',async t=>{
 const h=await setup(t);await h.seed('/keep.md','EXISTS ON DISK');h.ctx.server.files={'keep.md':{isFile:true,path:'/keep.md'}};h.ctx.getFileStatus=async()=>({status:'error'});
 const result=await h.ctx.collectModifiedAndDeletedFiles();assert.equal(await h.readOrNull('/keep.md'),'EXISTS ON DISK');assert.deepEqual(Array.from(result.deleted),['/keep.md']);
 t.diagnostic('Deletion candidate produced; no live upload or remote deletion performed. Candidate move patch does NOT fix this.');
});
test('sync classifier healthy file does not become deletion candidate',async t=>{
 const h=await setup(t);await h.seed('/keep.md','EXISTS');h.ctx.server.files={'keep.md':{isFile:true,path:'/keep.md'}};h.ctx.getFileStatus=async p=>({status:'notModified',path:p});const result=await h.ctx.collectModifiedAndDeletedFiles();assert.equal(result.deleted.length,0);
});
