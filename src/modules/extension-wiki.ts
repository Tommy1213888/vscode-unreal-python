import * as vscode from 'vscode';

export const WIKI_URL = "https://codeberg.org/nils-soderman/vscode-unreal-python/wiki/";


/**
 * Struct of pages available on the wiki.  
 * All values are static
 */
export class FPages {
    static readonly failedToConnect = "Failed-to-connect-to-Unreal-Engine";
    static readonly enableDevmode = "Unreal-Engine-Developer-Mode";
    static readonly configureTyCodeCompletion = "Setup-code-completion-for-ty";
}


/**
 * @param page The page to get the full URL of, should be a value of `FPages`
 * @returns The full page url
 */
export function getPageUrl(page: string): vscode.Uri {
    return vscode.Uri.parse(WIKI_URL + page);
}

/** 
 * Open a wiki page in the user's default webbrowser
 * @param page The page to open, should be a value of `FPages`
 */
export function openPageInBrowser(page: string) {
    const url = getPageUrl(page);
    return vscode.env.openExternal(url);
}