async function moveFile(oldPath, newPath) {
    if (oldPath === newPath) {
        return;
    }

    try {
        let file = await (await getFileHandle(oldPath)).getFile();
        let content = await file.text();
        await writeIfContentIsDifferent(newPath, content);

        log('saving ' + newPath);
        addMemFile(newPath, {
            isFile: true,
            content: content,
            lastModified: 0,
            path: newPath,
            handle: await getFileHandle(newPath),
        });
        // Don't preemptively setServerFile here - that would stamp the
        // server snapshot with hash(content), which makes getFileStatus
        // return 'notModified' on the next sync and the server never
        // receives newPath. Leaving serverFile null lets the sync see
        // it as 'new' and push it normally.

        // Server file will be removed here.
        await remove(oldPath);
        // delete files[oldDir][oldFilename];
        await renderSidebar();

        log(`Moved ${oldPath} to ${newPath}`);
    } catch (error) {
        logError('Error moving file:', error);
    }
}
