/**
 * Adds the directory where the 'unreal.py' stub file is generated to the `python.analysis.extraPaths` config.
 */

import * as vscode from 'vscode';

import * as path from 'path';

import * as remoteHandler from '../modules/remote-handler';
import * as extensionWiki from '../modules/extension-wiki';
import * as logger from '../modules/logger';
import * as utils from '../modules/utils';

export const STUB_FILE_NAME = "unreal.py";


interface ISettingsInfo {
    niceName: string;
    paths: string[] | undefined;
    scope: vscode.ConfigurationTarget;
    openSettingsCommand: string;
}

interface IInspectionSettings {
    globalValue?: string[];
    workspaceValue?: string[];
    workspaceFolderValue?: string[];
    defaultValue?: string[];
}

interface ILanguageServerExtInfo {
    extensionId: string;
    extraPathsConfigKey?: string;
    extensionName: string;
    publisherName: string;
}


/**
 * Get the path to the directory where the 'unreal.py' stubfile is generated,
 * Based on the currently connected Unreal Engine project.
 */
export async function getUnrealStubDirectory(): Promise<vscode.Uri | null> {
    const response = await remoteHandler.evaluateFunction("paths", "get_python_stub_dir");

    if (response && response.success) {
        // The result string contains quote characters, strip those
        const stubDirectoryPath = response.result.slice(1, -1);
        return vscode.Uri.file(stubDirectoryPath);
    }

    return null;
}

/**
 * Look for popular Python language server extensions and return the first one found, or null if none is found.
 */
function getLanguageServerExtension(): ILanguageServerExtInfo | null {
    const extensions_info: ILanguageServerExtInfo[] = [
        {
            extensionId: "astral-sh.ty",
            extensionName: "ty",
            publisherName: "Astral"
        },
        {
            extensionId: "ms-python.vscode-pylance",
            extraPathsConfigKey: "python.analysis.extraPaths",
            extensionName: "Pylance",
            publisherName: "Microsoft"
        },
        {
            extensionId: "detachhead.basedpyright",
            extraPathsConfigKey: "basedpyright.analysis.extraPaths",
            extensionName: "BasedPyright",
            publisherName: "DetachHead"
        }
    ];

    for (const ext of extensions_info) {
        const extension = vscode.extensions.getExtension(ext.extensionId);
        if (extension) {
            logger.info(`Found language server extension: ${ext.extensionId}.`);
            return ext;
        }
    }

    logger.info(`No supported language server extension found.`);

    vscode.window.showErrorMessage(
        `No Python LSP extension found. Please install one or manually add the stubs path to your LSP extension configuration.`,
        "Show Popular Python LSP Extensions"
    ).then(async (value) => {
        if (value === "Show Popular Python LSP Extensions") {
            const result = await vscode.window.showQuickPick(extensions_info.map(ext => ({
                label: ext.extensionName,
                description: `by ${ext.publisherName}`,
                extensionId: ext.extensionId
            })), {
                placeHolder: "Select an LSP extension to view in the marketplace"
            });

            if (result) {
                vscode.commands.executeCommand("extension.open", result.extensionId);
            }
        }
    });

    return null;
}

/** 
 * 
 */
function getSettingsInfo(extraPathsConfig: IInspectionSettings): ISettingsInfo {
    const bHasWorkspaceFileOpen = vscode.workspace.workspaceFile !== undefined;

    const valuesToCheck: ISettingsInfo[] = [
        {
            niceName: "Folder",
            paths: extraPathsConfig.workspaceFolderValue,
            scope: vscode.ConfigurationTarget.WorkspaceFolder,
            openSettingsCommand: bHasWorkspaceFileOpen ? "workbench.action.openFolderSettings" : "workbench.action.openWorkspaceSettings"
        },
        {
            niceName: "Workspace",
            paths: extraPathsConfig.workspaceValue,
            scope: vscode.ConfigurationTarget.Workspace,
            openSettingsCommand: "workbench.action.openWorkspaceSettings"
        }
    ];

    // Search through the different scopes to find the first one that has a custom value
    for (const value of valuesToCheck) {
        if (value.paths && value.paths !== extraPathsConfig.defaultValue) {
            return value;
        }
    }

    // Default to global/User settings
    return {
        niceName: "User",
        paths: extraPathsConfig.globalValue,
        scope: vscode.ConfigurationTarget.Global,
        openSettingsCommand: "workbench.action.openSettings"
    };
}


/**
 * Add a path to the `extraPaths` config. 
 * This function will also remove any current paths that ends w/ 'Intermediate/PythonStub' 
 * to prevent multiple Unreal stub directories beeing added
 * @param pathToAdd The path to add
*/
function addPythonAnalysisPath(pathToAdd: string): void {
    const lspExtInfo = getLanguageServerExtension();
    if (!lspExtInfo)
        return;

    if (lspExtInfo.extraPathsConfigKey) {
        // Extension provides a config with a list of paths to scan for code completion, insert our path
        const [lspSection, lspKey] = lspExtInfo.extraPathsConfigKey.split(/\.(.*)/s);

        const pythonConfig = vscode.workspace.getConfiguration(lspSection, utils.getActiveWorkspaceFolder()?.uri);

        let extraPathsConfig = pythonConfig.inspect<string[]>(lspKey);
        if (!extraPathsConfig) {
            logger.info(`Failed to get the config '${lspExtInfo.extraPathsConfigKey}'`);
            return;
        }

        const settingsInfo = getSettingsInfo(extraPathsConfig);

        // Create a new list that will contain the old paths and the new one
        let newPathsValue = settingsInfo.paths ? [...settingsInfo.paths] : [];

        // Check if the path already exists
        if (newPathsValue.some(path => utils.isPathsSame(path, pathToAdd))) {
            const message = `Path "${pathToAdd}" already exists in '${lspExtInfo.extraPathsConfigKey}' in ${settingsInfo.niceName} settings.`;
            logger.info(message);
            vscode.window.showInformationMessage(message);
        }

        // Make sure we only have one Unreal stub directory in the extra paths
        newPathsValue = newPathsValue.filter(path => !path.endsWith("Intermediate/PythonStub"));
        newPathsValue.push(pathToAdd);

        try {
            pythonConfig.update(lspKey, newPathsValue, settingsInfo.scope);
        }
        catch (error) {
            logger.showError(`Failed to update '${lspExtInfo.extraPathsConfigKey}' in ${settingsInfo.niceName} settings.`, error as Error);
            return;
        }

        logger.info(`Added path "${pathToAdd}" to '${lspExtInfo.extraPathsConfigKey}' in ${settingsInfo.niceName} settings.`);

        vscode.window.showInformationMessage(`Updated '${lspExtInfo.extraPathsConfigKey}' in ${settingsInfo.niceName} settings.`, "Show Setting").then(
            (value) => {
                if (value === "Show Setting") {
                    vscode.commands.executeCommand(settingsInfo.openSettingsCommand, lspExtInfo.extraPathsConfigKey);
                }
            }
        );
    }

    else {
        if (lspExtInfo.extensionId === "astral-sh.ty") {
            logger.info(`Cannot automatically configure "${lspExtInfo.extensionName}", please add the path "${pathToAdd}" to your configuration file manually.`);

            vscode.window.showWarningMessage(
                `Cannot automatically configure "${lspExtInfo.extensionName}", please add this path manually: "${pathToAdd}"`, "View Setup Guide"
            ).then((value) => {
                if (value === "View Setup Guide") {
                    extensionWiki.openPageInBrowser(extensionWiki.FPages.configureTyCodeCompletion);
                }
            });
        }
    }
}


/**
 * Validate that a 'unreal.py' stub file exists in given directory, and if so add it to the `extraPaths` config.
 * If a valid stub file doesn't exist, user will be prompted to enable developer mode and the path will NOT be added to the config.
 * @param stubDirectoryPath The directory where the 'unreal.py' stub file is located
 */
export async function validateStubAndAddToPath(stubDirectoryPath: vscode.Uri): Promise<void> {
    // Check if a generated stub file exists
    const stubFilepath = vscode.Uri.joinPath(stubDirectoryPath, STUB_FILE_NAME);

    if (!await utils.uriExists(stubFilepath)) {
        logger.info(`Failed to find the generated stub file: "${stubFilepath}"`);
        // A generated stub file could not be found, ask the user to enable developer mode first
        vscode.window.showErrorMessage(
            "To setup code completion you first need to enable Developer Mode in Unreal Engine's Python plugin settings, then restart the Unreal",
            "Help"
        ).then((item) => {
            if (item === "Help")
                extensionWiki.openPageInBrowser(extensionWiki.FPages.enableDevmode);
        });

        return;
    }

    addPythonAnalysisPath(stubDirectoryPath.fsPath);
}


export async function main() {
    const autoStubDirectoryPath = await getUnrealStubDirectory();
    if (autoStubDirectoryPath) {
        validateStubAndAddToPath(autoStubDirectoryPath);
    }
    else {
        const selectedItem = await vscode.window.showErrorMessage(
            "Setup Code Completion: Failed to automatically get the path to current Unreal Engine project",
            "Browse Manually"
        );

        if (selectedItem === "Browse Manually") {
            const selectedFiles = await vscode.window.showOpenDialog({
                "filters": { "Unreal Project": ["uproject"] },  // eslint-disable-line @typescript-eslint/naming-convention
                "canSelectMany": false,
                "title": "Select the Unreal Engine project file (.uproject) to setup code completion for",
                "openLabel": "Select project"
            });

            if (selectedFiles) {
                // `selectedFiles[0]` should now be the .uproject file that the user whish to setup code completion for
                const projectDirectory = vscode.Uri.file(path.dirname(selectedFiles[0].fsPath));
                const manualStubDirectoryPath = vscode.Uri.joinPath(projectDirectory, "Intermediate", "PythonStub");
                validateStubAndAddToPath(manualStubDirectoryPath);
            }
        }
    }
}
