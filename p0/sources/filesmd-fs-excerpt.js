/* Files.md source excerpt, MIT (see FILESMD-LICENSE).
 * Transcribed from web-rendered web/lib/fs.js lines 14–123 (1-indexed).
 * Not a complete repository checkout and not byte-verified against a commit.
 * Keep helper behavior unchanged; missing app globals are supplied by tests.
 */
async function getFileHandle(path, create = false) {
    let dir, filename;
    if (path.includes('/')) {
        const parts = path.split('/');
        filename = parts.pop();
        dir = parts.join('/');
    } else {
        dir = '';
        filename = path;
    }
    const dirs = dir.split('/');
    let currentDirHandle = await getRootDirHandle();
    for (const dirName of dirs) {
        if (dirName) {
            try {
                currentDirHandle = await currentDirHandle.getDirectoryHandle(dirName, {create: create});
            } catch (error) {
                throw error;
            }
        }
    }
    let fileHandle;
    try {
        fileHandle = await currentDirHandle.getFileHandle(filename, {create: create});
    } catch (error) {
        throw error;
    }

    return fileHandle;
}

async function read(path) {
    let fileHandle = await getFileHandle(path)
    let file = await fileHandle.getFile();

    return await file.text();
}
async function write(path, content) {
    let fileHandle = await getFileHandle(path, true);
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
}

async function writeAtEnd(path, content) {
    let fileHandle = await getFileHandle(path, true);
    if (fileHandle === null) {
        // TODO fix once Chromium fixes the bug
        throw new Error('Invalid file name');
    }
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    await writable.seek(await fileHandle.getFile().then(file => file.size));
    await writable.write(content);
    await writable.close();

    const file = await fileHandle.getFile();
    return file.lastModified;
}
// TODO save metadata & files
// Write only if content is different.
async function writeIfContentIsDifferent(path, content) {
    let fileHandle = await getFileHandle(path, true);
    if (fileHandle === null) {
        // TODO fix once Chromium fixes the bug
        throw new Error('Invalid file name');
    }
    const fileExists = !await exists(path);
    if (fileExists || !await isContentEqual(path, content)) {
        // TODO what if we're syncing first time and already have changes?
        log('Hashes do not match, writing file...', path);
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
    } else {
        log('Hashes match, no need to write file.');
    }
    const file = await fileHandle.getFile();
    return file.lastModified;
}

// Works only for files.
async function exists(path) {
    try {
        await getFileHandle(path);
        return true;
    } catch (error) {
        if (error.name === 'NotFoundError') {
            return false
        }
        throw error
    }
}
async function remove(path) {
    let fileHandle = await getFileHandle(path);
    if (fileHandle === null) {
        // TODO fix once Chromium fixes the bug
        logError('Malformed name, skipping file...');
        return;
    }
    await fileHandle.remove()
    log(`File ${path} removed successfully.`);

    removeMemFile(path);
}

async function rename(oldpath, newpath) {
    let content = await read(oldpath)
    await write(newpath, content)
    await remove(oldpath)
}
