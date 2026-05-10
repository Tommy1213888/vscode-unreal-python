/**
 * A module handling the connection between Unreal and VSCode
 */

import * as vscode from 'vscode';
import { execSync } from 'child_process';

import { RemoteExecution, RemoteExecutionConfig, RemoteExecutionNode, ECommandOutputType, EExecMode, IRemoteExecutionMessageCommandOutputData } from "unreal-remote-execution";

import * as extensionWiki from "./extension-wiki";
import * as utils from "./utils";
import * as logger from "./logger";

let gConnectionPromise: Promise<RemoteExecution | null> | null = null;
let gCachedRemoteExecution: RemoteExecution | null = null;
let gStatusBarItem: vscode.StatusBarItem | null = null;


// ------------------------------------
//          Status Bar Item
// ------------------------------------

function getStatusBarItem(bEnsureExists = true) {
    if (!gStatusBarItem && bEnsureExists) {
        gStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
        gStatusBarItem.command = "ue-python.selectInstance";
        gStatusBarItem.tooltip = "Connected Unreal Engine instance";
    }
    return gStatusBarItem;
}


export function removeStatusBarItem() {
    gStatusBarItem?.dispose();
    gStatusBarItem = null;
}


/**
 * Check if a multicast route exists for the given address on Linux
 */
function hasMulticastRoute(multicastAddress: string): boolean {
    try {
        const output = execSync(`ip route show ${multicastAddress}`, { encoding: 'utf8' });
        return output.trim().length > 0;
    } catch {
        return false;
    }
}


/**
 * Get a `RemoteExecutionConfig` based on the extension user settings
 */
function getRemoteConfig() {
    const extensionConfig = utils.getExtensionConfig();

    const multicastTTL: number | undefined = extensionConfig.get("remote.multicastTTL");

    let multicastBindAddress: string | undefined = extensionConfig.get("remote.multicastBindAddress");
    if (multicastBindAddress === "default") {
        multicastBindAddress = process.platform === "linux" ? "0.0.0.0" : "127.0.0.1";
    }

    let multicastGroupEndpoint: [string, number] | undefined = undefined;
    const multicastGroupEndpointStr: string | undefined = extensionConfig.get("remote.multicastGroupEndpoint");
    if (multicastGroupEndpointStr) {
        const [multicastGroupStr, portStr] = multicastGroupEndpointStr.split(":", 2);
        multicastGroupEndpoint = [multicastGroupStr, Number(portStr)];
    }

    let commandEndpoint: [string, number] | undefined = undefined;
    const commandEndpointStr: string | undefined = extensionConfig.get("remote.commandEndpoint");
    if (commandEndpointStr) {
        const [commandHost, commandPortStr] = commandEndpointStr.split(":", 2);
        commandEndpoint = [commandHost, Number(commandPortStr)];
    }

    return new RemoteExecutionConfig(multicastTTL, multicastGroupEndpoint, multicastBindAddress, commandEndpoint);
}


/**
 * Make sure the command port is avaliable, and if not it'll try to find a port that's free and modify the port in config to use this new port.
 * @param config The remote execution config
 * @returns A list with 2 elements, the first one is a boolean depending on if a free port was found/assigned to the config. Second element is a error message.
 */
async function ensureCommandPortAvaliable(config: RemoteExecutionConfig): Promise<boolean> {
    const extensionConfig = utils.getExtensionConfig();

    const host = config.commandEndpoint[0];
    const commandEndpointPort = config.commandEndpoint[1];

    // Check if user has enabled 'strictPort' 
    if (extensionConfig.get("strictPort")) {
        if (!await utils.isPortAvailable(commandEndpointPort, host)) {
            vscode.window.showErrorMessage(`Port ${commandEndpointPort} is currently busy. Consider changing the config: 'ue-python.remote.commandEndpoint'.`);
            return false;
        }
    }
    else {
        // Check the next 100 ports, one should hopefully be free
        const freePort = await utils.findFreePort(commandEndpointPort, 101, host);
        if (!freePort) {
            vscode.window.showErrorMessage(`All ports between ${commandEndpointPort} - ${commandEndpointPort + 100} are busy. Consider changing the config: 'ue-python.remote.commandEndpoint'.`);
            return false;
        }

        // If the first found free port wasn't the original port, update it
        if (commandEndpointPort !== freePort) {
            config.commandEndpoint[1] = freePort;
        }
    }

    return true;
}


/**
 * Get the port the remote execution command connection is using
 */
export async function getRemoteExecutionCommandPort() {
    const remoteExecution = await getRemoteExecutionInstance(false);
    if (!remoteExecution)
        return null;

    return remoteExecution.config.commandEndpoint[1];
}


/**
 * Get the global remote connection instance
 * @param bEnsureConnection Make sure the remote execution instance exists, if not it'll create one.
 */
export async function getRemoteExecutionInstance(bEnsureExists = true) {
    if (!gCachedRemoteExecution && bEnsureExists) {
        const config = getRemoteConfig();
        if (await ensureCommandPortAvaliable(config)) {
            gCachedRemoteExecution = new RemoteExecution(config);
            gCachedRemoteExecution.events.addEventListener("commandConnectionClosed", onRemoteConnectionClosed);
            await gCachedRemoteExecution.start();

            logger.info("Remote execution instance created");
            logger.info(`Multicast TTL: ${config.multicastTTL}`);
            logger.info(`Multicast Bind Address: ${config.multicastBindAddress}`);
            logger.info(`Multicast Group Endpoint: ${config.multicastGroupEndpoint[0]}:${config.multicastGroupEndpoint[1]}`);
            logger.info(`Command Endpoint: ${config.commandEndpoint[0]}:${config.commandEndpoint[1]}`);
        }
    }

    return gCachedRemoteExecution;
}


/**
 * Get the global remote connection instance, and make sure it's connected
 * @returns The remote execution instance, or null if it failed to connect
 */
export async function getConnectedRemoteExecutionInstance(): Promise<RemoteExecution | null> {
    const remoteExecution = await getRemoteExecutionInstance();
    if (!remoteExecution)
        return null;

    if (remoteExecution.hasCommandConnection())
        return remoteExecution;

    if (!gConnectionPromise) {
        gConnectionPromise = (async () => {
            const config = getRemoteConfig();

            if (!await ensureCommandPortAvaliable(config))
                return null;

            const extensionConfig = utils.getExtensionConfig();
            const timeout: number = extensionConfig.get("remote.timeout") ?? 3000;

            if (process.platform === "linux") {
                const multicastAddr = config.multicastGroupEndpoint[0];
                if (!hasMulticastRoute(multicastAddr)) {
                    vscode.window.showErrorMessage(
                        `Multicast route not configured. Run: \`sudo ip route add ${multicastAddr} dev lo\``,
                        "Copy Command"
                    ).then(item => {
                        if (item === "Copy Command")
                            vscode.env.clipboard.writeText(`sudo ip route add ${multicastAddr} dev lo`);
                    });
                    return null;
                }
            }

            logger.info(`Connecting with a timeout of ${timeout}ms.`);

            let node: RemoteExecutionNode;
            try {
                node = await remoteExecution.getFirstRemoteNode(1000, timeout);
            }
            catch (error: any) {
                logger.error(error);
                let message: string = error.message;
                if (message.startsWith("Timed out"))
                    message = "Timed out while trying to connect to Unreal Engine.";

                vscode.window.showErrorMessage(message, "Help").then((clickedItem) => {
                    if (clickedItem === "Help")
                        extensionWiki.openPageInBrowser(extensionWiki.FPages.failedToConnect);
                });

                return null;
            }

            const connected = await connectToRemoteInstance(remoteExecution, node, timeout);
            return connected ? remoteExecution : null;
        })().then(result => {
            if (result === null) {
                closeRemoteConnection();
            }
            return result;
        }).finally(() => {
            gConnectionPromise = null;
        });
    }

    return gConnectionPromise;
}


/**
 * Connect to a remote Unreal Engine instance and run the setup required for the extension to work properly
 */
export async function connectToRemoteInstance(instance: RemoteExecution, node: RemoteExecutionNode, timeout: number) {
    try {
        await instance.openCommandConnection(node, true, timeout);
        logger.info("Connected to: " + JSON.stringify(node.data));

        await onRemoteInstanceCreated(node);

        return true;
    }
    catch (error: any) {
        logger.showError("Failed to connect to Unreal Engine", error);
        closeRemoteConnection();
    }

    return false;
}


/**
 * Called when a remote instance is created
 */
async function onRemoteInstanceCreated(node: RemoteExecutionNode) {
    const statusBarItem = getStatusBarItem();
    if (statusBarItem) {
        statusBarItem.text = `$(unreal-engine) ${node.data.project_name}`;
        statusBarItem.show();
    }

    // Append the extension's site-packages folder to the python path in Unreal
    const sitePackagesPath = vscode.Uri.joinPath(utils.getExtensionUri(), "site-packages");
    const setupCommand = `import sys;sys.path.append(r'${sitePackagesPath.fsPath}');import json;import vscode_unreal;`;
    let response = await runCommand(setupCommand, false);
    if (!response?.success) {
        logger.error("Failed to append site-packages to python path in Unreal Engine");
        return;
    }

    // Check if we should add any workspace folders to the python path
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        let foldersToAddToPath: string[] = [];
        for (const folder of workspaceFolders) {
            const config = vscode.workspace.getConfiguration(utils.EXTENSION_ID, folder.uri);
            if (config.get<boolean>('environment.addWorkspaceToPath', false)) {
                foldersToAddToPath.push(folder.uri.fsPath);
            }
        }

        if (foldersToAddToPath.length > 0) {
            await evaluateFunction("add_sys_path", "add_paths",
                {
                    paths: foldersToAddToPath
                }
            );
        }
    }
}


/**
 * Called when the remote connection is closed
 */
async function onRemoteConnectionClosed() {
    const remoteExecution = await getRemoteExecutionInstance(false);
    if (!remoteExecution?.hasCommandConnection())
        removeStatusBarItem();

    logger.info("Remote connection closed");
}


/**
 * Send a command to the remote connection
 * @param command The python code as a string
 */
export async function runCommand(command: string, bEval = false) {
    const remoteExec = await getConnectedRemoteExecutionInstance();
    if (!remoteExec) {
        return;
    }

    const bUnattended = utils.getExtensionConfig().get("execute.unattended") ? true : false;
    const mode = bEval ? EExecMode.EVALUATE_STATEMENT : EExecMode.EXECUTE_STATEMENT;

    return remoteExec.runCommand(command, bUnattended, mode);
}


export async function evaluateFunction(moduleName: string, functionName: string, kwargs: any = {}, logOutput = true) {
    let command = `vscode_unreal.${moduleName}.${functionName}(`;
    if (Object.keys(kwargs).length > 0) {
        command += `**json.loads(r'${JSON.stringify(kwargs)}')`;
    }
    command += `)`;

    const response = await runCommand(command, true);
    if (response) {
        if (logOutput) {
            for (const output of response.output) {
                if (output.type === ECommandOutputType.ERROR)
                    logger.error(output.output.trimEnd());
                else if (output.type === ECommandOutputType.WARNING)
                    logger.warn(output.output.trimEnd());
                else
                    logger.info(output.output.trimEnd());
            }
        }

        if (!response.success)
            logger.showError("Extension ran into an error", new Error(response.result));
    }

    return response;
}


/**
 * Close the global remote connection, if there is one
 */
export async function closeRemoteConnection() {
    gCachedRemoteExecution?.stop();
    gCachedRemoteExecution = null;
}