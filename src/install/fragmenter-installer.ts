import EventEmitter from 'events';
import path from 'path';
import * as os from 'os';
import fs from 'fs-extra';
import { promisify } from 'util';
import readRecurse from 'fs-readdir-recursive';
import TypedEventEmitter from '../typed-emitter';
import { FragmenterUpdateChecker } from '../checks';
import { DistributionModule, FragmenterInstallerEvents, InstallInfo, InstallManifest, UpdateInfo } from '../types';
import { INSTALL_MANIFEST } from '../constants';
import { ModuleDownloader } from './module-downloader';
import { ModuleDecompressor } from './module-decompressor';
import { FragmenterError, FragmenterErrorCode, UnrecoverableErrors } from '../errors';
import { FragmenterContext, FragmenterOperation } from '../core';
import { timer } from '../utils';

const DEFAULT_TEMP_DIRECTORY_PREFIX = 'fragmenter-temp';

/**
 * Options passed to a {@link FragmenterInstaller}
 */
export type InstallOptions = Partial<{
    /**
     * Provides a custom temporary directory for use when extracting compressed modules.
     *
     * **Warning:** if this is specified, the caller must make sure the provided directory is unique.
     *
     * Defaults to a randomised directory in `os.tmpdir()`.
     */
    temporaryDirectory: string,

    /**
     * Maximum amount of retries when downloading a module fails.
     *
     * Defaults to `5`.
     */
    maxModuleRetries: number,

    /**
     * Whether to force a fresh install.
     *
     * Defaults to `false`.
     */
    forceFreshInstall: boolean,

    /**
     * Whether to force using cache busting for the manifest.
     *
     * Defaults to `false`.
     */
    forceManifestCacheBust: boolean,

    forceCacheBust: boolean,

    /**
     * Disables falling back to a full module download after exhausting the max amount of module retries.
     *
     * Defaults to `false`.
     */
    disableFallbackToFull: boolean,
}>;

export class FragmenterInstaller extends (EventEmitter as new () => TypedEventEmitter<FragmenterInstallerEvents>) {
    private readonly options: InstallOptions;

    constructor(
        private readonly ctx: FragmenterContext,
        private readonly baseUrl: string,
        private readonly destDir: string,
        options: InstallOptions,
    ) {
        // eslint-disable-next-line constructor-super
        super();

        this.options = {
            temporaryDirectory: path.join(os.tmpdir(), `${DEFAULT_TEMP_DIRECTORY_PREFIX}-${(Math.random() * 1_000_000).toFixed(0)}`),
            maxModuleRetries: 5,
            forceFreshInstall: false,
            disableFallbackToFull: false,
            ...options,
        };
    }

    async install(): Promise<InstallInfo> {
        try {
            return await this.doInstall();
        } catch (e) {
            this.ctx.logError('[FragmenterInstaller] Error during install. See exception below');

            let backedUpInstallFilesExist = false;
            try {
                await fs.access(path.join(this.options.temporaryDirectory, 'restore'));

                backedUpInstallFilesExist = true;
            } catch (e) {
                // noop
            }

            if (backedUpInstallFilesExist) {
                this.ctx.currentPhase = { op: FragmenterOperation.InstallFailRestore };

                try {
                    await this.ensureDestDirIsEmpty();
                    await this.restoreBackedUpFiles();
                } catch (e) {
                    this.ctx.logError('[FragmenterInstaller] Error restoring backed up files. See exception below');

                    this.emit('error', e);
                }
            }

            if (FragmenterError.isFragmenterError(e)) {
                throw e;
            } else {
                throw FragmenterError.createFromError(e);
            }
        } finally {
            this.ctx.currentPhase = { op: FragmenterOperation.Done };

            await this.ensureTempDirRemoved();
        }
    }

    private async doInstall(): Promise<InstallInfo> {
        const updater = new FragmenterUpdateChecker();

        this.ctx.logTrace('[FragmenterInstaller] Determining update info');

        this.ctx.currentPhase = { op: FragmenterOperation.UpdateCheck };

        let updateInfo: UpdateInfo;
        try {
            updateInfo = await updater.needsUpdate(this.baseUrl, this.destDir, { ...this.options, forceCacheBust: this.ctx.options.forceCacheBust || this.options.forceManifestCacheBust });
        } catch (e) {
            this.ctx.logError('[FragmenterInstaller] Error while checking for updates. See exception below');

            throw e;
        }

        this.ctx.currentPhase = { op: FragmenterOperation.InstallBegin };

        if (!updateInfo.needsUpdate) {
            this.ctx.logInfo('[FragmenterInstaller] No update needed - doing nothing');

            return { changed: false, manifest: updateInfo.existingManifest };
        }

        let newInstallManifest: InstallManifest;

        const allUpdated = updateInfo.updatedModules.length + updateInfo.removedModules.length === updateInfo.existingManifest?.modules.length;

        if (allUpdated || updateInfo.isFreshInstall) {
            this.ctx.logInfo('[FragmenterInstaller] All modules need update - performing full install');

            newInstallManifest = await this.performFullInstall(updateInfo);
        } else {
            this.ctx.logInfo('[FragmenterInstaller] Not all modules need update - performing modular update');

            newInstallManifest = await this.performModularUpdate(updateInfo);
        }

        this.ctx.currentPhase = { op: FragmenterOperation.InstallFinish };

        return this.finishInstall(newInstallManifest);
    }

    private async performFullInstall(updateInfo: UpdateInfo): Promise<InstallManifest> {
        this.emit('fullDownload');

        await this.ensureTempDirExists();
        await this.backupExistingFiles();
        await this.ensureDestDirIsEmpty();

        const fullModule: DistributionModule = {
            name: 'full',
            sourceDir: '.',
            hash: updateInfo.distributionManifest.fullHash,
            splitFileCount: updateInfo.distributionManifest.fullSplitFileCount,
            completeFileSize: updateInfo.distributionManifest.fullCompleteFileSize,
            completeFileSizeUncompressed: updateInfo.distributionManifest.fullCompleteFileSizeUncompressed,
        };

        await this.downloadAndInstallModule(fullModule);

        return {
            ...updateInfo.distributionManifest,
            source: this.baseUrl,
        };
    }

    private async performModularUpdate(updateInfo: UpdateInfo): Promise<InstallManifest> {
        this.emit('modularUpdate');

        await this.ensureTempDirExists();
        await this.backupExistingFiles();

        const newInstallManifest: InstallManifest = {
            modules: [],
            base: {
                hash: '',
                files: [],
                splitFileCount: 0,
                completeFileSize: 0,
                completeFileSizeUncompressed: 0,
            },
            fullHash: '',
            fullSplitFileCount: 0,
            fullCompleteFileSize: 0,
            fullCompleteFileSizeUncompressed: 0,
            source: this.baseUrl,
        };

        if (updateInfo.baseChanged) {
            this.ctx.logInfo('[FragmenterInstaller] Base files changed - updating');

            try {
                for (const file of updateInfo.existingManifest.base.files) {
                    const absolutePath = path.join(this.options.temporaryDirectory, file);

                    try {
                        await fs.access(absolutePath);

                        await promisify(fs.rm)(absolutePath);
                    } catch (e) {
                        // noop
                    }
                }

                const baseModule = {
                    name: 'Base',
                    sourceDir: '.',
                    hash: updateInfo.distributionManifest.base.hash,
                    splitFileCount: updateInfo.distributionManifest.base.splitFileCount,
                    completeFileSize: updateInfo.distributionManifest.base.completeFileSize,
                    completeFileSizeUncompressed: updateInfo.distributionManifest.base.completeFileSizeUncompressed,
                };

                await this.downloadAndInstallModule(baseModule);

                newInstallManifest.base = updateInfo.distributionManifest.base;
            } catch (e) {
                const isMaxRetriesReached = FragmenterError.isFragmenterError(e) && e.code === FragmenterErrorCode.MaxModuleRetries;

                if (isMaxRetriesReached && !this.options?.disableFallbackToFull) {
                    return this.performFullInstall(updateInfo);
                }

                throw e;
            }
        } else {
            this.ctx.logTrace('[FragmenterInstaller] Base files not changed');
        }

        newInstallManifest.modules = updateInfo.existingManifest.modules;

        for (const module of [...updateInfo.removedModules, ...updateInfo.updatedModules]) {
            this.ctx.logInfo(`[FragmenterInstaller] Removing module '${module.name}'`);

            const fullPath = path.join(this.destDir, module.sourceDir);

            let moduleDirExists = false;
            try {
                await fs.access(fullPath);

                moduleDirExists = true;
            } catch (e) {
                // noop
            }

            if (moduleDirExists) {
                await promisify(fs.rm)(fullPath, { recursive: true });

                this.ctx.logTrace(`[FragmenterInstaller] Done removing module '${module.name}'`);
            } else {
                this.ctx.logWarn(`[FragmenterInstaller] Module '${module.name}' marked for removal not found`);
            }

            const moduleIndexInManifest = newInstallManifest.modules.findIndex((m) => m.name === module.name);

            newInstallManifest.modules.splice(moduleIndexInManifest, 1);
        }

        try {
            for (const module of [...updateInfo.updatedModules, ...updateInfo.addedModules]) {
                const newModule = updateInfo.distributionManifest.modules.find((m) => m.name === module.name);

                this.ctx.logInfo(`[FragmenterInstaller] Installing new or updated module '${newModule.name}'`);

                newInstallManifest.modules.push(newModule);

                await this.downloadAndInstallModule(newModule);
            }

            newInstallManifest.fullHash = updateInfo.distributionManifest.fullHash;
            newInstallManifest.fullSplitFileCount = updateInfo.distributionManifest.fullSplitFileCount;
            newInstallManifest.fullCompleteFileSize = updateInfo.distributionManifest.fullCompleteFileSize;
        } catch (error) {
            const isMaxRetriesReached = FragmenterError.isFragmenterError(error) && error.code === FragmenterErrorCode.MaxModuleRetries;

            if (isMaxRetriesReached && !this.options?.disableFallbackToFull) {
                return this.performFullInstall(updateInfo);
            }

            throw error;
        }

        return newInstallManifest;
    }

    async downloadAndInstallModule(module: DistributionModule): Promise<void> {
        let retryCount = 0;
        while (retryCount < 5) {
            try {
                await this.tryDownloadAndInstallModule(module);

                return;
            } catch (e) {
                if (FragmenterError.isFragmenterError(e)) {
                    throw e;
                } else if (this.ctx.signal.aborted) {
                    this.ctx.logError(module, 'AbortSignal triggered');

                    throw FragmenterError.create(FragmenterErrorCode.UserAborted, 'AbortSignal triggered after retry scheduled');
                } else {
                    const fragmenterError = FragmenterError.createFromError(e);

                    if (UnrecoverableErrors.includes(fragmenterError.code)) {
                        this.ctx.logError(
                            `[FragmenterInstaller] Unrecoverable error (${FragmenterErrorCode[fragmenterError.code]}) encountered during module '${module.name}' download and install`,
                        );

                        throw fragmenterError;
                    }

                    this.emit('error', e);
                }

                retryCount++;

                const retryIn = 2 ** retryCount;

                this.emit('retryScheduled', module, retryCount - 1, retryIn);
                this.ctx.logInfo(`[ModuleDownloader] Retrying module in ${retryIn}`);

                await timer(retryIn * 1_000);
            }
        }

        throw FragmenterError.create(
            FragmenterErrorCode.MaxModuleRetries,
            `max number of retries reached for module '${module.name}'`,
        );
    }

    private async tryDownloadAndInstallModule(module: DistributionModule): Promise<void> {
        this.ctx.logInfo(`[FragmenterInstaller] Downloading and installing module '${module.name}'`);

        this.emit('downloadStarted', module);

        const downloader = new ModuleDownloader(this.ctx, this.baseUrl, module);

        downloader.on('progress', (p) => {
            const pct = Math.round((p.loaded / p.total) * 100);

            this.emit('downloadProgress', module, { ...p, percent: pct });
        });

        downloader.on('downloadInterrupted', (fromUserAction) => {
            this.emit('downloadInterrupted', module, fromUserAction);
        });

        downloader.on('error', (e) => this.emit('error', e));

        await downloader.startDownload(this.options.temporaryDirectory);

        this.emit('downloadFinished', module);

        const decompressor = new ModuleDecompressor(this.ctx, module);

        decompressor.on('progress', (p) => this.emit('unzipProgress', module, p));

        const moduleZipPath = path.join(this.options.temporaryDirectory, `${module.name}.zip`);
        const extractDir = path.join(this.options.temporaryDirectory, 'extract', module.name);

        this.emit('unzipStarted', module);
        await decompressor.decompress(moduleZipPath, extractDir);
        this.emit('unzipFinished', module);

        this.emit('copyStarted', module);
        await this.moveOverExtractedFiles(module);
        this.emit('copyFinished', module);

        await this.cleanupTempModuleFiles(module);

        this.ctx.logTrace(`[FragmenterInstaller] Done downloading and installing module '${module.name}'`);
    }

    private async cleanupTempModuleFiles(module: DistributionModule) {
        this.ctx.logTrace(`[FragmenterInstaller] Cleaning up temporary module files for '${module.name}'`);

        const moduleZipPath = path.join(this.options.temporaryDirectory, module.name, '.zip');
        const moduleExtractDir = path.join(this.options.temporaryDirectory, 'extract', module.name);

        let moduleZipExists = false;
        try {
            await fs.access(moduleZipPath);

            moduleZipExists = true;
        } catch (e) {
            // noop
        }

        let moduleExtractDirExists = false;
        try {
            await fs.access(moduleExtractDir);

            moduleExtractDirExists = true;
        } catch (e) {
            // noop
        }

        try {
            if (moduleZipExists) {
                await promisify(fs.rm)(moduleZipPath);
            }

            if (moduleExtractDirExists) {
                await promisify(fs.rm)(moduleExtractDir, { recursive: true });
            }
        } catch (e) {
            this.ctx.logError('[FragmenterInstaller] Error while cleaning up module temp files');

            this.emit('error', e);
        }

        this.ctx.logTrace(`[FragmenterInstaller] Done cleaning up temporary module files for '${module.name}'`);
    }

    private async moveOverExtractedFiles(module: DistributionModule) {
        const extractedDir = path.join(this.options.temporaryDirectory, 'extract', module.name);
        const destModuleDir = path.join(this.destDir, module.sourceDir);

        this.ctx.logInfo(`[FragmenterInstaller] Moving files from '${extractedDir}' -> '${destModuleDir}'`);

        const files = readRecurse(extractedDir);

        let moved = 0;
        for (const file of files) {
            const absoluteSourcePath = path.resolve(extractedDir, file);
            const absoluteDestPath = path.resolve(destModuleDir, file);

            try {
                await fs.move(absoluteSourcePath, absoluteDestPath);

                this.emit('copyProgress', module, { moved: ++moved, total: files.length });
            } catch (e) {
                this.ctx.logError(`[FragmenterInstaller] Error while moving over file '${absoluteSourcePath}' -> '${absoluteDestPath}'`);

                throw FragmenterError.createFromError(e);
            }
        }

        this.ctx.logTrace('[FragmenterInstaller] Done moving files');
    }

    private async ensureTempDirExists() {
        try {
            const tempDirExists = await promisify(fs.exists)(this.options.temporaryDirectory);

            if (!tempDirExists) {
                await fs.mkdir(this.options.temporaryDirectory);
            }
        } catch (e) {
            this.ctx.logError('[FragmenterInstaller] Error while creating temp directory');

            this.emit('error', e);
        }
    }

    private async ensureTempDirRemoved() {
        let tempDirExists = false;
        try {
            await fs.access(this.options.temporaryDirectory);

            tempDirExists = true;
        } catch (e) {
            // noop
        }

        if (tempDirExists) {
            try {
                await promisify(fs.rm)(this.options.temporaryDirectory, { recursive: true });
            } catch (e) {
                this.ctx.logError('[FragmenterInstaller] Error while removing temp directory');

                this.emit('error', e);
            }
        }
    }

    private async ensureDestDirIsEmpty() {
        try {
            await promisify(fs.rm)(this.destDir, { recursive: true });
        } catch (e) {
            this.emit('error', '[FragmenterInstaller] Error while emptying dest directory');
        }

        try {
            await promisify(fs.mkdir)(this.destDir);
        } catch (e) {
            this.emit('error', '[FragmenterInstaller] Error while re-creating dest directory');
        }
    }

    private async backupExistingFiles() {
        this.ctx.logInfo('[FragmenterInstaller] Backing up existing install files');

        this.emit('backupStarted');

        const backupDir = path.join(this.options.temporaryDirectory, 'restore');

        const files = readRecurse(this.destDir);

        for (const file of files) {
            const absoluteSourcePath = path.resolve(this.destDir, file);
            const absoluteDestPath = path.resolve(backupDir, file);

            try {
                await fs.move(absoluteSourcePath, absoluteDestPath);
            } catch (e) {
                this.ctx.logError(`[FragmenterInstaller] Error while moving over file '${absoluteSourcePath}' -> '${absoluteDestPath}'`);

                throw FragmenterError.createFromError(e);
            }
        }

        this.emit('backupFinished');

        this.ctx.logTrace('[FragmenterInstaller] Done backing existing install files');
    }

    private async restoreBackedUpFiles() {
        this.ctx.logInfo('[FragmenterInstaller] Restoring backed up install files');

        const backupDir = path.join(this.options.temporaryDirectory, 'restore');

        const files = readRecurse(backupDir);

        for (const file of files) {
            const absoluteSourcePath = path.resolve(backupDir, file);
            const absoluteDestPath = path.resolve(this.destDir, file);

            try {
                await fs.move(absoluteSourcePath, absoluteDestPath);
            } catch (e) {
                this.ctx.logError(`[FragmenterInstaller] Error while moving over file '${absoluteSourcePath}' -> '${absoluteDestPath}'`);

                throw FragmenterError.createFromError(e);
            }
        }

        this.ctx.logTrace('[FragmenterInstaller] Done restoring backed up install files');
    }

    private async finishInstall(installManifest: InstallManifest): Promise<InstallInfo> {
        const canceled = this.ctx.signal.aborted;

        if (!canceled) {
            const manifestPath = path.join(this.destDir, INSTALL_MANIFEST);

            this.ctx.logInfo(`[FragmenterInstaller] Writing install manifest to '${manifestPath}'`);

            await fs.writeJSON(manifestPath, installManifest);

            this.ctx.logTrace('[FragmenterInstaller] Wrote install manifest');
        }

        this.ctx.logInfo('[FragmenterInstaller] Install finished');

        this.ctx.currentPhase = { op: FragmenterOperation.Done };

        return {
            changed: !canceled,
            manifest: installManifest,
        };
    }
}
