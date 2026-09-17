async function getFileStatus(path) {
    let content;
    try {
        const memFile = getMemFile(path);
        let fileHandle = memFile?.handle;
        // First try to get the file from memory, if not found try to open from local fs.
        if (!(fileHandle instanceof FileSystemFileHandle)) {
            fileHandle = await getFileHandle(path, false);
        }
        if (!(fileHandle instanceof FileSystemFileHandle)) {
            logError("Error while getting file handle for status check", path);
            return {
                status: 'error',
            }
        }

        const file = await memFile.handle.getFile();
        content = await file.text();
    } catch (error) {
        logError('Error while getting status for file', path, error);
        return {
            status: 'error',
        }
    }

    // TODO why path is stored at all?
    // const path = serverFiles?.files?.[dir]?.[filename]?.path;
    let serverFile = getServerFile(path);
    // log('STATUS', path, serverFile);
    if (serverFile === null) {
        log('NEW LOCAL FILE ' + path);
        return {
            status: 'new',
            content: content,
            path: path,
            lastModified: 0 // new file
        }
    }

    const serverHash = serverFile.hash;
    const serverTime = serverFile.lastModified;
    if (serverHash !== hash(content)) {
        log('NEW MODIFIED LOCAL FILE ' + path);
        return {
            status: 'modified',
            content: content,
            path: path,
            lastModified: serverTime,
        };
    }

    return {
        status: 'notModified',
        path: path,
    };
}
