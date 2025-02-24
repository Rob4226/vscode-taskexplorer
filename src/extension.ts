/* eslint-disable prefer-arrow/prefer-arrow-functions */

/* ---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
    Disposable, ExtensionContext, Uri, tasks, TaskProvider,
    workspace, window, FileSystemWatcher, ConfigurationChangeEvent, WorkspaceFolder, Task
} from "vscode";
import { TaskTreeDataProvider } from "./tree/tree";
import { AntTaskProvider } from "./providers/ant";
import { MakeTaskProvider } from "./providers/make";
import { MavenTaskProvider } from "./providers/maven";
import { ScriptTaskProvider } from "./providers/script";
import { GradleTaskProvider } from "./providers/gradle";
import { GruntTaskProvider } from "./providers/grunt";
import { GulpTaskProvider } from "./providers/gulp";
import { AppPublisherTaskProvider } from "./providers/appPublisher";
import { configuration } from "./common/configuration";
import { initStorage } from "./common/storage";
import { views } from "./views";
import { TaskExplorerProvider } from "./providers/provider";
import * as util from "./common/utils";
import * as cache from "./cache";
import * as log from "./common/log";


export let treeDataProvider: TaskTreeDataProvider | undefined;
export let treeDataProvider2: TaskTreeDataProvider | undefined;
export let appDataPath: string;


const watchers: Map<string, FileSystemWatcher> = new Map();
const watcherDisposables: Map<string, Disposable> = new Map();
export const providers: Map<string, TaskExplorerProvider> = new Map();
export interface TaskExplorerApi
{
    explorerProvider: TaskTreeDataProvider | undefined;
    sidebarProvider: TaskTreeDataProvider | undefined;
    utilities: any;
    fileCache: any;
}


export async function activate(context: ExtensionContext, disposables: Disposable[]): Promise<TaskExplorerApi>
{
    log.initLog("taskExplorer", "Task Explorer", context);
    initStorage(context);

    log.write("");
    log.write("Init extension");

    //
    // Register file type watchers
    //
    await registerFileWatchers(context);

    //
    // Register internal task providers.  Npm, VScode type tasks are provided
    // by VSCode, not internally.
    //
    registerTaskProviders(context);

    //
    // Register the tree providers
    //
    if (configuration.get<boolean>("enableSideBar")) {
        treeDataProvider = registerExplorer("taskExplorerSideBar", context);
    }
    if (configuration.get<boolean>("enableExplorerView")) {
        treeDataProvider2 = registerExplorer("taskExplorer", context);
    }

    //
    // Refresh tree when folders are added/removed from the workspace
    //
    const workspaceWatcher = workspace.onDidChangeWorkspaceFolders(async(_e) =>
    {
        await addWsFolder(_e.added);
        await removeWsFolder(_e.removed);
        await refreshTree();
    });
    context.subscriptions.push(workspaceWatcher);

    //
    // Register configurations/settings change watcher
    //
    const d = workspace.onDidChangeConfiguration(async e => {
        await processConfigChanges(context, e);
    });
    context.subscriptions.push(d);

    log.write("   Task Explorer activated");

    return {
        explorerProvider: treeDataProvider2,
        sidebarProvider: treeDataProvider,
        utilities: util,
        fileCache: cache
    };
}


export async function addWsFolder(wsf: readonly WorkspaceFolder[] | undefined)
{
    if (wsf)
    {
        for (const f in wsf) {
            if (wsf.hasOwnProperty(f)) { // skip over properties inherited by prototype
                log.write("Workspace folder added: " + wsf[f].name, 1);
                await cache.addFolderToCache(wsf[f]);
            }
        }
    }
}


export async function deactivate()
{
    for (const [ k, d ] of watcherDisposables) {
        d.dispose();
    }

    for (const [ k, w ] of watchers) {
        w.dispose();
    }

    await cache.cancelBuildCache(true);
}


export async function removeWsFolder(wsf: readonly WorkspaceFolder[] | undefined, logPad = "")
{
    log.methodStart("process remove workspace folder", 1, logPad, true);

    if (!wsf) {
        return;
    }

    for (const f of wsf)
    {
        log.value("      folder", f.name, 1, logPad);
        // window.setStatusBarMessage("$(loading) Task Explorer - Removing projects...");
        await util.forEachMapAsync(cache.filesCache, (files: Set<cache.ICacheItem>, provider: string) =>
        {
            const toRemove: cache.ICacheItem[] = [];

            log.value("      start remove task files from cache", provider, 2, logPad);

            for (const file of files)
            {
                log.value("         checking cache file", file.uri.fsPath, 4, logPad);
                if (file.folder.uri.fsPath === f.uri.fsPath) {
                    log.write("            added for removal",  4, logPad);
                    toRemove.push(file);
                }
            }

            if (toRemove.length > 0)
            {
                for (const tr of toRemove) {
                    log.value("         remove file", tr.uri.fsPath, 2, logPad);
                    files.delete(tr);
                }
            }

            log.value("      completed remove files from cache", provider, 2, logPad);
        });
        log.write("   folder removed", 1, logPad);
    }

    log.methodDone("process remove workspace folder", 1, logPad, true);
}


async function processConfigChanges(context: ExtensionContext, e: ConfigurationChangeEvent)
{
    let refresh = false;
    const refreshTaskTypes: string[] = [],
          taskTypes = util.getTaskTypes();

    const registerChange = (taskType: string) => {
        if (util.existsInArray(refreshTaskTypes, taskType) === false) {
            refreshTaskTypes.push(taskType);
        }
    };

    //
    // Check configs that may require a tree refresh...
    //

    //
    // if the 'autoRefresh' settings if truned off, then there's nothing to do
    //
    if (configuration.get<boolean>("autoRefresh") === false) {
        return;
    }

    //
    // Main excludes list cahnges requires global refresh
    //
    if (e.affectsConfiguration("taskExplorer.exclude")) {
        refresh = true;
    }

    //
    // Groupings changes require global refresh
    //
    if (e.affectsConfiguration("taskExplorer.groupWithSeparator") || e.affectsConfiguration("taskExplorer.groupSeparator") ||
        e.affectsConfiguration("taskExplorer.groupMaxLevel") || e.affectsConfiguration("taskExplorer.groupStripTaskLabel")) {
        refresh = true;
    }

    //
    // Show/hide last tasks
    //
    if (e.affectsConfiguration("taskExplorer.showLastTasks"))
    {
        if (configuration.get<boolean>("enableSideBar") && treeDataProvider)
        {
            await treeDataProvider.showSpecialTasks(configuration.get<boolean>("showLastTasks"));
        }
        if (configuration.get<boolean>("enableExplorerView") && treeDataProvider2)
        {
            await treeDataProvider2.showSpecialTasks(configuration.get<boolean>("showLastTasks"));
        }
    }

    //
    // Enable/disable task types
    //
    for (const i in taskTypes)
    {
        if (taskTypes.hasOwnProperty(i))
        {
            const taskType = taskTypes[i],
                taskTypeP = taskType !== "app-publisher" ? util.properCase(taskType) : "AppPublisher",
                enabledSetting = "enable" + taskTypeP;
            if (e.affectsConfiguration("taskExplorer." + enabledSetting))
            {
                const ignoreModify = util.isScriptType(taskType) || taskType === "app-publisher";
                await registerFileWatcher(context, taskType, util.getGlobPattern(taskType), ignoreModify, configuration.get<boolean>(enabledSetting));
                registerChange(taskType);
            }
        }
    }

    //
    // Path changes to task programs require task executions to be re-set up
    //
    for (const type of util.getTaskTypes())
    {
        if (type === "app-publisher") {
            if (e.affectsConfiguration("taskExplorer.pathToAppPublisher")) {
                refreshTaskTypes.push("app-publisher");
            }
        }
        else if (e.affectsConfiguration("taskExplorer.pathTo" + util.properCase(type))) {
            refreshTaskTypes.push(type);
        }
    }

    //
    // Extra Apache Ant 'include' paths
    //
    if (e.affectsConfiguration("taskExplorer.includeAnt")) {
        if (util.existsInArray(refreshTaskTypes, "ant") === false){
            await registerFileWatcher(context, "ant", util.getAntGlobPattern(), false, configuration.get<boolean>("enableAnt"));
            registerChange("ant");
        }
    }

    //
    // Whether or not to use the 'ant' program to detect ant tasks (default is xml2js parser)
    //
    if (e.affectsConfiguration("taskExplorer.useAnt")) {
        registerChange("ant");
    }

    //
    // Whether or not to use the 'gulp' program to detect gulp tasks (default is custom parser)
    //
    if (e.affectsConfiguration("taskExplorer.useGulp")) {
        registerChange("gulp");
    }

    //
    // NPM Package Manager change (NPM / Yarn)
    // Do a global refrsh since we don't provide the npm tasks, VSCode itself does
    //
    if (e.affectsConfiguration("npm.packageManager", undefined)) {
        registerChange("npm");
    }

    //
    // Enabled/disable sidebar view
    //
    if (e.affectsConfiguration("taskExplorer.enableSideBar"))
    {
        if (configuration.get<boolean>("enableSideBar")) {
            if (treeDataProvider) {
                // TODO - remove/add view on enable/disable view
                refresh = true;
            }
            else {
                treeDataProvider = registerExplorer("taskExplorerSideBar", context);
            }
        }
    }

    //
    // Enabled/disable explorer view
    //
    if (e.affectsConfiguration("taskExplorer.enableExplorerView"))
    {
        if (configuration.get<boolean>("enableExplorerView")) {
            if (treeDataProvider2) {
                // TODO - remove/add view on enable/disable view
                refresh = true;
            }
            else {
                treeDataProvider2 = registerExplorer("taskExplorer", context);
            }
        }
    }

    //
    // Integrated shell
    //
    if (e.affectsConfiguration("terminal.integrated.shell.windows") ||
        e.affectsConfiguration("terminal.integrated.shell.linux") ||
        e.affectsConfiguration("terminal.integrated.shell.macos")) {
        //
        // Script type task defs will change with terminal change
        //
        if (configuration.get<boolean>("enableBash") || configuration.get<boolean>("enableBatch") ||
            configuration.get<boolean>("enablePerl") || configuration.get<boolean>("enablePowershell") ||
            configuration.get<boolean>("enablePython") || configuration.get<boolean>("enableRuby") ||
            configuration.get<boolean>("enableNsis")) {
            refresh = true;
        }
    }

    if (refresh) {
        await refreshTree();
    }
    else if (refreshTaskTypes?.length > 0) {
        for (const t of refreshTaskTypes) {
            await refreshTree(t);
        }
    }
}


async function registerFileWatchers(context: ExtensionContext)
{
    const taskTypes = util.getTaskTypes();
    for (const t of taskTypes)
    {
        const taskType = t,
            taskTypeP = taskType !== "app-publisher" ? util.properCase(taskType) : "AppPublisher";
        if (configuration.get<boolean>("enable" + taskTypeP))
        {
            const watchModify = util.isScriptType(taskType) || taskType === "app-publisher";
            await registerFileWatcher(context, taskType, util.getGlobPattern(taskType), watchModify);
        }
    }
}


export async function refreshTree(taskType?: string, uri?: Uri)
{
    // let refreshedTasks = false;
    // window.setStatusBarMessage("$(loading) Task Explorer - Refreshing tasks...");

    //
    // If this request is from a filesystem event for a file that exists in an ignored path,
    // then get out of here
    //
    if (uri && util.isExcluded(uri.path)) {
        return;
    }

    //
    // Refresh tree(s)
    //
    // Note the static task cache only needs to be refreshed once if both the explorer view
    // and the sidebar view are being used and/or enabled
    //
    if (configuration.get<boolean>("enableSideBar") && treeDataProvider) {
        await treeDataProvider.refresh(taskType, uri);
    }
    if (configuration.get<boolean>("enableExplorerView") && treeDataProvider2) {
        await treeDataProvider2.refresh(taskType, uri);
    }
}


function registerTaskProvider(providerName: string, provider: TaskExplorerProvider, context: ExtensionContext)
{
    context.subscriptions.push(tasks.registerTaskProvider(providerName, provider));
    providers.set(providerName, provider);
}


function registerTaskProviders(context: ExtensionContext)
{   //
    // Internal Task Providers
    //
    // These tak types are provided internally by the extension.  Some task types (npm, grunt,
    //  gulp) are provided by VSCode itself
    //
    // TODO: VSCODE API now implements "resolveTask" in addition to "provideTask".  Need to implement
    //     https://code.visualstudio.com/api/extension-guides/task-provider
    //
    registerTaskProvider("ant", new AntTaskProvider(), context);                      // Apache Ant Build Automation Tool
    registerTaskProvider("app-publisher", new AppPublisherTaskProvider(), context);   // App Publisher (work related)
    registerTaskProvider("gradle", new GradleTaskProvider(), context);                // Gradle Mulit-Language Automation Tool
    registerTaskProvider("grunt", new GruntTaskProvider(), context);                  // Gulp JavaScript Toolkit
    registerTaskProvider("gulp", new GulpTaskProvider(), context);                    // Grunt JavaScript Task Runner
    registerTaskProvider("make", new MakeTaskProvider(), context);                    // C/C++ Makefile
    registerTaskProvider("maven", new MavenTaskProvider(), context);                  // Apache Maven Toolset
    //
    // The 'script' provider handles all file based 'scripts', e.g. batch files, bash, powershell, etc
    //
    registerTaskProvider("script", new ScriptTaskProvider(), context);
}


async function registerFileWatcher(context: ExtensionContext, taskType: string, fileBlob: string, ignorehModify?: boolean, enabled?: boolean)
{
    log.write("Register file watcher for task type '" + taskType + "'");

    let watcher = watchers.get(taskType);

    if (workspace.workspaceFolders) {
        await cache.buildCache(taskType, fileBlob);
    }

    if (watcher)
    {
        const watcherDisposable = watcherDisposables.get(taskType);
        if (watcherDisposable)
        {
            watcherDisposable.dispose();
            watcherDisposables.delete(taskType);
        }
    }

    if (enabled !== false)
    {
        if (!watcher) {
            watcher = workspace.createFileSystemWatcher(fileBlob);
            watchers.set(taskType, watcher);
            context.subscriptions.push(watcher);
        }
        if (!ignorehModify) {
            watcherDisposables.set(taskType, watcher.onDidChange(async _e => {
                logFileWatcherEvent(_e, "change");
                await refreshTree(taskType, _e);
            }));
        }
        watcherDisposables.set(taskType, watcher.onDidDelete(async _e => {
            logFileWatcherEvent(_e, "delete");
            await cache.removeFileFromCache(taskType, _e);
            await refreshTree(taskType, _e);
        }));
        watcherDisposables.set(taskType, watcher.onDidCreate(async _e => {
            logFileWatcherEvent(_e, "create");
            await cache.addFileToCache(taskType, _e);
            await refreshTree(taskType, _e);
        }));
    }
}


function logFileWatcherEvent(uri: Uri, type: string)
{
    log.write("file change event");
    log.value("   type", type);
    log.value("   file", uri.fsPath);
}


function registerExplorer(name: string, context: ExtensionContext, enabled?: boolean): TaskTreeDataProvider | undefined
{
    log.write("Register explorer view / tree provider '" + name + "'");

    if (enabled !== false)
    {
        if (workspace.workspaceFolders)
        {
            const treeDataProvider = new TaskTreeDataProvider(name, context);
            const treeView = window.createTreeView(name, { treeDataProvider, showCollapseAll: true });
            treeView.onDidChangeVisibility(async _e => {
                if (_e.visible) {
                    log.write("view visibility change event");
                    await refreshTree("visible-event");
                }
            });
            views.set(name, treeView);
            const view = views.get(name);
            if (view) {
                context.subscriptions.push(view);
                log.write("   Tree data provider registered'" + name + "'");
            }
            return treeDataProvider;
        }
        else {
            log.write("✘ No workspace folders!!!");
        }
    }

    return undefined;
}
