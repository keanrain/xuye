/**
 * Fixed-ref functions + Node disk test seams. No browser, live HTTP server,
 * real vault, model, or remote deletion. Baseline red tests are intentional.
 * Candidate mode loads the reviewed function replacements, NOT an alternate
 * hand-written classifier hidden inside the test.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { File } = require('node:buffer');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const ROOT = path.resolve(__dirname, '../..');
const PIN = path.join(ROOT, 'p0/pinned/9e948ba');
const CANDIDATE = process.env.XUYE_DELETE_GUARD === '1';
const SOURCE = CANDIDATE ? path.join(ROOT, 'p0/candidates/delete-guard') : path.join(PIN, 'web');

async function setup(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xuye-scan-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const mem = {};
    const calls = { post: [], read: [], probe: [], removedSnapshot: [], logs: [] };
    const faults = { read: new Set(), probe: new Set(), root: false };
    const diskPath = p => {
        const parts = p.split('/').filter(Boolean);
        if (parts.some(s => s === '.' || s === '..' || s.includes('\\'))) throw new Error('Invalid test path');
        return path.join(root, ...parts);
    };
    const permissionError = () => Object.assign(new Error('Injected test-only permission error'), { name: 'NotAllowedError' });
    function mapFsError(e) { if (e.code === 'ENOENT') e.name = 'NotFoundError'; throw e; }
    function setMem(tree, p, value) {
        const parts = p.split('/').filter(Boolean); const leaf = parts.pop();
        let current = tree;
        for (const part of parts) current = current[part + '/'] ||= {};
        current[leaf] = value;
    }
    function getMem(tree, p) {
        const parts = p.split('/').filter(Boolean); let current = tree;
        for (let i = 0; i < parts.length; i++) current = current?.[parts[i] + (i < parts.length - 1 ? '/' : '')];
        return current ?? null;
    }
    function dropMem(tree, p) {
        const parts = p.split('/').filter(Boolean); const leaf = parts.pop(); let current = tree;
        for (const part of parts) { current = current[part + '/']; if (!current) return; }
        delete current[leaf];
    }
    function walk(tree, callback, prefix = '/') {
        for (const [key, value] of Object.entries(tree)) {
            if (value.isFile) callback(prefix + key, true);
            else { callback(prefix + key, false); walk(value, callback, prefix + key); }
        }
    }
    function hash(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
        return h;
    }
    class TestFileHandle {
        constructor(p) { this.p = p; this.name = path.posix.basename(p); this.kind = 'file'; }
        async getFile() {
            calls.read.push(this.p);
            if (faults.read.has(this.p)) throw permissionError();
            try { return new File([await fs.readFile(diskPath(this.p))], this.name); }
            catch (e) { mapFsError(e); }
        }
    }
    // Read-only handle surface is enough for original read()/exists().
    function dirHandle(prefix = '') {
        return {
            async getDirectoryHandle(name, options = {}) {
                assert.notEqual(options.create, true, 'sync scan must not create directories');
                const p = prefix + '/' + name;
                if (faults.probe.has(p)) throw permissionError();
                try { await fs.access(diskPath(p)); } catch (e) { mapFsError(e); }
                return dirHandle(p);
            },
            async getFileHandle(name, options = {}) {
                assert.notEqual(options.create, true, 'sync scan must not create files');
                const p = prefix + '/' + name; calls.probe.push(p);
                if (faults.probe.has(p)) throw permissionError();
                try { await fs.access(diskPath(p)); } catch (e) { mapFsError(e); }
                return new TestFileHandle(p);
            }
        };
    }
    const server = { files: {}, timestamps: { '/': 100 }, serverTime: 100 };
    const ctx = vm.createContext({
        files: mem, server, editor: { path: '/current.md' }, editor2: { path: '/second.md' },
        FileSystemFileHandle: TestFileHandle, getMemFile: p => getMem(mem, p),
        getServerFile: p => getMem(server.files, p), hash, walk,
        getRootDirHandle: async () => { if (faults.root) throw permissionError(); return dirHandle(); },
        log: (...args) => calls.logs.push(['log', ...args]),
        logError: (...args) => calls.logs.push(['error', ...args]),
        console: { warn: (...args) => calls.logs.push(['warn', ...args]) },
        LOG_PATH: '/log.md', toFilename: p => path.posix.basename(p),
        isMediaPath: p => /\.(png|jpg|jpeg|gif|webp|mp4|webm|mov|mp3|ogg|oga|weba|wav)$/i.test(p),
        alert: text => calls.logs.push(['alert', text]),
        localStorage: { removeItem: key => calls.removedSnapshot.push(key) },
        isSyncingFiles: false, hasLastServerOk: () => true, debug: false, performance,
        post: async (endpoint, payload) => {
            calls.post.push({ endpoint, payload: JSON.parse(JSON.stringify(payload)) });
            return { json: { files: [], timestamps: { '/': 101 }, renames: null, deleted: null }, error: null };
        },
        removeServerFile: p => dropMem(server.files, p),
        saveServerFiles: () => calls.logs.push(['saveServerFiles']),
        joinPath: (...parts) => path.posix.join(...parts)
    });
    const helperBytes = await fs.readFile(path.join(PIN, 'web/lib/fs.js'));
    const blob = createHash('sha1').update(`blob ${helperBytes.length}\0`).update(helperBytes).digest('hex');
    assert.equal(blob, '16e853ae2096dda936d7006619fe9d12c0d09493');
    vm.runInContext(helperBytes.toString(), ctx, { filename: 'pinned/web/lib/fs.js' });
    for (const [dir, file] of [
        [path.join(PIN, 'web'), 'getFileStatus.function.js'],
        [SOURCE, 'collectModifiedAndDeletedFiles.function.js'],
        [SOURCE, 'syncFilesWithServer.function.js']
    ]) vm.runInContext(await fs.readFile(path.join(dir, file), 'utf8'), ctx, { filename: path.join(dir, file) });

    async function seed(p, content = 'ORIGINAL', options = {}) {
        await fs.mkdir(path.dirname(diskPath(p)), { recursive: true });
        await fs.writeFile(diskPath(p), content);
        if (options.inMemory !== false) setMem(mem, p, { isFile: true, path: p, handle: new TestFileHandle(p) });
        if (options.onServer !== false) setMem(server.files, p, {
            isFile: true, path: p, hash: hash(options.serverContent ?? content), lastModified: 100
        });
    }
    function remoteOnly(p) { setMem(server.files, p, { isFile: true, path: p, hash: hash('OLD'), lastModified: 100 }); }
    const readDisk = p => fs.readFile(diskPath(p), 'utf8');
    return { ctx, calls, faults, seed, remoteOnly, readDisk, server };
}
const incomplete = e => e?.code === 'LOCAL_SCAN_INCOMPLETE';

test('healthy unchanged file is neither modified nor deleted', async t => {
    const h = await setup(t); await h.seed('/keep.md');
    const r = await h.ctx.collectModifiedAndDeletedFiles();
    assert.equal(r.modified.length, 0); assert.equal(r.deleted.length, 0);
});
test('healthy new and modified text remains uploadable', async t => {
    const h = await setup(t);
    await h.seed('/new.md', 'NEW', { onServer: false });
    await h.seed('/edit.md', 'EDITED', { serverContent: 'OLD' });
    const r = await h.ctx.collectModifiedAndDeletedFiles();
    assert.deepEqual(Array.from(r.modified, x => x.path).sort(), ['/edit.md', '/new.md']);
    assert.equal(r.deleted.length, 0);
});
test('confirmed missing legacy path remains a deletion candidate, not an actual deletion', async t => {
    const h = await setup(t); await h.seed('/keep.md'); h.remoteOnly('/gone.md');
    const r = await h.ctx.collectModifiedAndDeletedFiles();
    assert.deepEqual(Array.from(r.deleted), ['/gone.md']);
    assert.equal(h.calls.post.length, 0); assert.equal(await h.readDisk('/keep.md'), 'ORIGINAL');
});
test('actual pinned getFileStatus read error aborts classification', async t => {
    const h = await setup(t); await h.seed('/keep.md'); h.faults.read.add('/keep.md');
    assert.equal((await h.ctx.getFileStatus('/keep.md')).status, 'error');
    await assert.rejects(h.ctx.collectModifiedAndDeletedFiles(), incomplete);
    assert.equal(await h.readDisk('/keep.md'), 'ORIGINAL');
});
test('rejected status promise is normalized to incomplete scan', async t => {
    const h = await setup(t); await h.seed('/keep.md');
    h.ctx.getFileStatus = async () => { throw new Error('injected rejection'); };
    await assert.rejects(h.ctx.collectModifiedAndDeletedFiles(), incomplete);
});
test('synchronous status exception is normalized to incomplete scan', async t => {
    const h = await setup(t); await h.seed('/keep.md');
    h.ctx.getFileStatus = () => { throw new Error('injected synchronous failure'); };
    await assert.rejects(h.ctx.collectModifiedAndDeletedFiles(), incomplete);
});
test('unexpected status is not accepted as evidence of presence or deletion', async t => {
    const h = await setup(t); await h.seed('/keep.md');
    h.ctx.getFileStatus = async p => ({ status: 'unknown', path: p });
    await assert.rejects(h.ctx.collectModifiedAndDeletedFiles(), incomplete);
});
test('mismatched result path cannot cause another path to be deleted', async t => {
    const h = await setup(t); await h.seed('/keep.md');
    h.ctx.getFileStatus = async () => ({ status: 'notModified', path: '/wrong.md' });
    await assert.rejects(h.ctx.collectModifiedAndDeletedFiles(), incomplete);
});
test('modified result without text payload blocks the batch', async t => {
    const h = await setup(t); await h.seed('/keep.md');
    h.ctx.getFileStatus = async p => ({ status: 'modified', path: p });
    await assert.rejects(h.ctx.collectModifiedAndDeletedFiles(), incomplete);
});
test('stale memory tree cannot authorize deletion of a file still on disk', async t => {
    const h = await setup(t); await h.seed('/anchor.md');
    await h.seed('/keep.md', 'STILL HERE', { inMemory: false });
    await assert.rejects(h.ctx.collectModifiedAndDeletedFiles(), incomplete);
    assert.equal(await h.readDisk('/keep.md'), 'STILL HERE');
});
test('permission failure probing a deletion candidate is not NotFound', async t => {
    const h = await setup(t); await h.seed('/anchor.md'); h.remoteOnly('/unknown.md');
    h.faults.probe.add('/unknown.md');
    await assert.rejects(h.ctx.collectModifiedAndDeletedFiles(), incomplete);
});
test('root handle failure cannot authorize inferred deletions', async t => {
    const h = await setup(t); await h.seed('/anchor.md'); h.remoteOnly('/unknown.md');
    h.faults.root = true;
    await assert.rejects(h.ctx.collectModifiedAndDeletedFiles(), incomplete);
});
test('text-sync exclusions apply equally to local and server scans', async t => {
    const h = await setup(t); await h.seed('/keep.md');
    for (const p of ['/media/picture.png', '/notes/voice.mp3', '/log.md', '/current.md', '/second.md']) {
        h.remoteOnly(p); h.faults.probe.add(p);
    }
    const r = await h.ctx.collectModifiedAndDeletedFiles();
    assert.equal(r.deleted.length, 0); assert.equal(h.calls.probe.length, 0);
});
test('too-many-deletions guard preserves the confirmed server snapshot', async t => {
    const h = await setup(t); await h.seed('/keep.md');
    for (let i = 0; i < 21; i++) h.remoteOnly(`/gone-${i}.md`);
    const before = JSON.stringify(h.server);
    await assert.rejects(h.ctx.collectModifiedAndDeletedFiles());
    assert.equal(JSON.stringify(h.server), before);
    assert.deepEqual(h.calls.removedSnapshot, []);
});
test('mixed good change and read failure sends zero batches and changes no snapshot', async t => {
    const h = await setup(t); await h.seed('/keep.md'); await h.seed('/edit.md', 'NEW', { serverContent: 'OLD' });
    h.faults.read.add('/keep.md'); const before = JSON.stringify(h.server);
    await h.ctx.syncFilesWithServer();
    assert.equal(h.calls.post.length, 0, 'no upload, including apparently-good changes');
    assert.equal(JSON.stringify(h.server), before);
    assert.equal(h.ctx.isSyncingFiles, false);
    assert.equal(await h.readDisk('/keep.md'), 'ORIGINAL');
    assert.equal(await h.readDisk('/edit.md'), 'NEW');
});
test('scan rejection releases the in-flight flag without uploading', async t => {
    const h = await setup(t); await h.seed('/keep.md');
    h.ctx.getFileStatus = async () => { throw new Error('injected failure'); };
    await h.ctx.syncFilesWithServer();
    assert.equal(h.ctx.isSyncingFiles, false);
    assert.equal(h.calls.post.length, 0);
});
test('after a blocked scan, clearing the fault permits a normal retry', async t => {
    const h = await setup(t); await h.seed('/edit.md', 'NEW', { serverContent: 'OLD' });
    h.faults.read.add('/edit.md');
    await h.ctx.syncFilesWithServer();
    assert.equal(h.calls.post.length, 0);
    h.faults.read.clear();
    await h.ctx.syncFilesWithServer();
    assert.equal(h.calls.post.length, 1);
    assert.equal(h.calls.post[0].payload.modified[0].content, 'NEW');
    assert.deepEqual(h.calls.post[0].payload.deleted, []);
    assert.equal(h.ctx.isSyncingFiles, false);
});
test('healthy caller still submits one batch and updates the confirmed cursor', async t => {
    const h = await setup(t); await h.seed('/edit.md', 'NEW', { serverContent: 'OLD' });
    await h.ctx.syncFilesWithServer();
    assert.equal(h.calls.post.length, 1);
    assert.equal(h.server.timestamps['/'], 101);
    assert.equal(h.ctx.isSyncingFiles, false);
});
