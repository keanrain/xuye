async function collectModifiedAndDeletedFiles() {
    const modifiedFiles = [];
    const existingFiles = new Set();
    const failedPaths = new Set();
    const promises = [];

    // Freeze the two independently-synced editor paths for this scan.
    const editorPath = editor.path;
    const editor2Path = editor2.path;
    const inScope = path => path !== LOG_PATH && !path.startsWith('/media/')
        && !isMediaPath(path) && path !== editorPath && path !== editor2Path;

    function requireCompleteScan() {
        if (failedPaths.size === 0) return;
        const error = new Error('Local file scan incomplete; no batch may be uploaded.');
        error.code = 'LOCAL_SCAN_INCOMPLETE';
        error.paths = Array.from(failedPaths).sort();
        throw error;
    }

    walk(files, (path, isFile) => {
        if (!isFile || !inScope(path)) return;

        // Presence and readability are different facts. Never turn a failed
        // content read into evidence that this path was deleted.
        existingFiles.add(path);
        const promise = Promise.resolve().then(() => getFileStatus(path))
            .then(result => {
                if (!result || !['new', 'modified', 'notModified'].includes(result.status)
                    || result.path !== path
                    || (result.status !== 'notModified' && typeof result.content !== 'string')) {
                    failedPaths.add(path);
                    return;
                }
                if (result.status === 'modified' || result.status === 'new') {
                    modifiedFiles.push(result);
                }
            })
            .catch(() => failedPaths.add(path));
        promises.push(promise);
    });
    await Promise.all(promises);
    requireCompleteScan();

    // The in-memory tree may be stale. Probe a missing path without creating
    // it before keeping the legacy deletion candidate. Only exists() returning
    // false (NotFoundError) confirms absence; any other error blocks the batch.
    const deletionCandidates = [];
    walk(server.files, (path, isFile) => {
        if (!isFile || !inScope(path)) return;
        if (/[<>:'|?*\\/\x00-\x1F\x7F]/.test(toFilename(path))) return;
        if (!existingFiles.has(path)) deletionCandidates.push(path);
    });

    const deleted = [];
    await Promise.all(deletionCandidates.map(async path => {
        try {
            if (await exists(path)) {
                failedPaths.add(path); // Present on disk, absent from the scan.
            } else {
                deleted.push(path);
            }
        } catch {
            failedPaths.add(path);
        }
    }));
    requireCompleteScan();

    // Preserve the last confirmed server snapshot, including on this guard.
    if (deleted.length > 20) {
        alert(`Sync paused: ${deleted.length} deletion candidates need review.`);
        const error = new Error('Too many deletion candidates; nothing uploaded.');
        error.code = 'TOO_MANY_DELETIONS';
        throw error;
    }

    return { modified: modifiedFiles, deleted: deleted.sort() };
}
