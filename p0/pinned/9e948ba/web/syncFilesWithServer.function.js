async function syncFilesWithServer() {
    // We should have at least one 200 response from service.
    // The first 200 response we get from /token, meaning that
    // our application is linked to the server for sync.
    if (!hasLastServerOk()) {
        return;
    }
    if (files === undefined || Object.keys(files).length === 0) {
        return;
    }
    if (debug) {
        return;
    }

    if (isSyncingFiles) return;
    isSyncingFiles = true;

    const startTime = performance.now();
    log('Starting sync with server...');

    // Send locally modified files and timestamps of last seen dirs from the server
    // TODO check if we fully synced at least once (timestamps exists)

    let modified = [];
    let deleted = [];
    // TODO is it possible that the server has zero files? I think at least '.' is sent
    let hasFullySyncedFilesAtLeastOnce = server['timestamps'] !== undefined && Object.keys(server['timestamps']).length > 0;
    ;
    if (hasFullySyncedFilesAtLeastOnce) {
        log('SYNCED AT LEAST ONCE, collecting local files', server['timestamps']);
        ({modified, deleted} = await collectModifiedAndDeletedFiles());
    } else {
        log('NEVER SYNCED BEFORE');
    }
    const { json: response, error } = await post('syncFilenames', {
        modified: modified,
        deleted: deleted,
        timestamps: server['timestamps'] || [],
        serverTime: server['serverTime'] || 0,
    });
    if (error) {
        logError('syncFilenames failed:', error);
        isSyncingFiles = false;
        return;
    }

    // Remove info about server files on client
    for (const path of deleted) {
        removeServerFile(path);
    }

    try {
        // Write files received from the server
        let failedAtLeastOnce = false;
        for (const fileInfo of response.files) {
            let {path, content, lastModified} = fileInfo;
            // We get relative paths from server, and in our app we use absolute paths
            const relPath = path;
            path = joinPath('/', relPath);

            // If it is current file, skip, because we sync it separately
            // TODO if we skip current, don't take it's timestamp? We had a bug when sync was broken for 1 file
            // TODO fix missing / for root files
            if (path === editor.path || path === editor2.path) {
                log('Skip receiving current file during bath sync', path);
                continue;
            }

            try {
                const lastClientModified = await writeIfContentIsDifferent(path, content)
                addMemFile(path, {
                    isFile: true,
                    content: content,
                    lastModified: lastModified,
                    lastClientModified: lastClientModified,
                    path: path,
                    handle: await getFileHandle(path),
                });

                log('SYNC texts: write file: ', path);
                setServerFile(path, content, lastModified, lastClientModified);
                // Unfortunately rename is not working, so we have to delete the old file
                // TODO write e2e for renames
                const shouldRemoveOldFile = response.renames !== null && relPath in response.renames;
                if (shouldRemoveOldFile) {
                    const oldPath = joinPath('/', response.renames[relPath]);
                    try {
                        log('DELETED due to renaming', oldPath);
                        await remove(oldPath);
                    } catch (err) {
                        log('RENAME: cant remove file: ', err, path);
                    }
                }
                saveServerFiles();
            } catch (error) {
                logError(`Error saving file ${path}:`, error);
                if (!error.message.includes('Name is not allowed')) {
                    failedAtLeastOnce = true;
                }
            }
        }
        // Apply server-side deletions: drop any local file that was deleted on
        // server. Local copies older than the recorded deletedAt are deleted.
        // If local change is newer than deletedAt - we skip deletion.
        if (response.deleted) {
            const serverTime = server['serverTime'] || 0;
            for (const [relPath, deletedAt] of Object.entries(response.deleted)) {
                const path = joinPath('/', relPath);
                const local = getMemFile(path);
                if (!local) continue;
                if (local.lastModified > deletedAt) continue;
                try {
                    log('SYNC: deleting locally due to server fslog:', path);
                    // await remove(path);
                    // removeServerFile(path);
                } catch (err) {
                    logError('SYNC: cant delete locally:', err, path);
                }
            }
            server['serverTime'] = serverTime;
            saveServerFiles();
        }

        // Only move timestamp pointers when we were able to sync all the files.
        // Otherwise we can have situation when we synced files only partially,
        // let's say serverFiles is having only half files from server, then they
        // will be sent by subsequent syncTexts call, because collectLocalFiles
        // would report them as new.
        if (!failedAtLeastOnce) {
            log('BATCH sync ok, moving timestamps');
            server['timestamps'] = response.timestamps;
            saveServerFiles();
        } else {
            log("BATCH sync error, timestamps aren't moved");
        }
    } catch (error) {
        logError("Can't sync:", error.message)
    }

    log('Sync completed in ' + (performance.now() - startTime) + 'ms');

    isSyncingFiles = false;
}
