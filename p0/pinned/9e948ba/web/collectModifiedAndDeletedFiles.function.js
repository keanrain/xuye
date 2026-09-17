async function collectModifiedAndDeletedFiles() {
    const modifiedFiles = [];
    const existingFiles = {};
    const promises = [];

    // Freeze paths to prevent RC. Current file can change during collecting.
    const editorPath = editor.path;
    const editor2Path = editor2.path;
    log('Frozen paths:', editorPath, editor2Path);
    walk(files, (path, isFile) => {
        if (!isFile) {
            return;
        }

        if (path.startsWith('/media/') || path === LOG_PATH) {
            return;
        }
        // Binary media files (images, video) anywhere in the tree must not
        // go through the text sync path - file.text() corrupts them and the
        // JSON-escaped string can balloon past MaxFilenamesSize, returning
        // 400 from syncFilenames. They sync via syncMediaFile when in /media/.
        if (isMediaPath(path)) {
            return;
        }

        // TODO write tests for that?
        if (path === editorPath || path === editor2Path) {
            log('Skip sending current file: ' + path);
            return;
        }

        const promise = getFileStatus(path)
            .then(result => {
                if (result.status === 'modified' || result.status === 'new') {
                    modifiedFiles.push(result);
                }

                if (result.status !== 'error') {
                    existingFiles[result.path] = true;
                } else {
                    console.warn(`Error getting status for file ${path}:`, result);
                }
            });
        promises.push(promise);
    });

    await Promise.all(promises);

    // Find deleted files that are in server files but not in existing files.
    let deleted = [];
    walk(server.files, (path, isFile) => {
        if (!isFile) {
            return;
        }

        // Chromium doesn't support those chars on any OS
        if (/[<>:'|?*\\/\x00-\x1F\x7F]/.test(toFilename(path))) {
            return;
        }

        // Skip current files.
        if (path === editorPath || path === editor2Path) {
            return;
        }

        if (existingFiles[path] === undefined) {
            log('DELETED because not in existing or modified files:', path);
            log('Current editors paths:', editor.path, editor2.path);
            // Log files entry
            log('Mem file:', getMemFile(path));
            deleted.push(path);
        }
    });

    // If there are too many deleted files, prob something is wrong, throw an alert
    if (deleted.length > 20) {
        alert(`Trying to delete more than 20 deleted files during sync (${deleted.length}). I won't proceed, please resolve the issue manually. Probably "files" is empty in local stroage for some reason, but there are actual files on the disk.`);
        // Show first 10 files
        alert('First 10 files: \n' + deleted.slice(0, 10).join('\n'));
        localStorage.removeItem("server");
        throw new Error('Too many deleted files during sync, aborting.');
        deleted = [];
    }

    return {
        modified: modifiedFiles,
        deleted: deleted,
    };
}
