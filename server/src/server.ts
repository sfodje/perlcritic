/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	TextDocumentSyncKind,
} from 'vscode-languageserver/node';

import {TextDocument} from 'vscode-languageserver-textdocument';

import * as child_process from 'child_process';
import { accessSync, constants } from 'fs';

import Critique from './Critique';
import Output from './Output';
import * as which from 'which';


// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we will fall back using global settings
	hasConfigurationCapability =
		!!(capabilities.workspace && !!capabilities.workspace.configuration);
	hasWorkspaceFolderCapability =
		!!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
	hasDiagnosticRelatedInformationCapability =
		!!(capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation);

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
		}
	};
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(
			DidChangeConfigurationNotification.type,
			undefined
		);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface PerlcriticSettings {
	maxNumberOfProblems: number;
	executable: string;
	severity: string;
	onSave: boolean;
	additionalArguments: Array<string>;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: PerlcriticSettings = {
	maxNumberOfProblems: 10,
	executable: "perlcritic",
	severity: "gentle",
	onSave: false,
	additionalArguments: ['--quiet', ["--verbose", "%l[>]%c[>]%s[>]%m. %e (%p)[>]%d[[END]]"].join('=')]
};
let globalSettings: PerlcriticSettings = defaultSettings;

connection.onDidChangeConfiguration(change => {
	try {
		globalSettings = mergeSettings(change.settings.perlcritic);
	} catch (error) {
		// do nada
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

// we need a cache for validateExecutable is a bit slow
let __validateExecutableCache: Array<string> = [];

function validateExecutable(executable: string): string {
	if (__validateExecutableCache.length == 0 || __validateExecutableCache[0] != executable) {
		let result: string = "";
		try {
			// path with '/' are considered to be valid if file is runnable
			if (executable.indexOf("/") > -1) {
				try {
					accessSync(executable, constants.X_OK);
					result = executable;
				} catch (error) {
					// not an executable, continue
				}
			}
			result = which.sync(executable);
		}
		catch (error) {
			connection.window.showErrorMessage("" + error);
		}
		__validateExecutableCache = [executable, result];
	}
	return __validateExecutableCache[1]
}

function mergeSettings(newSettings: PerlcriticSettings): PerlcriticSettings {
	if (!newSettings) {
		return defaultSettings;
	}

	newSettings.executable = newSettings.executable;

	// Only set severity if user does not specify a profile,
	// because perlcritic will ignore the profile if severity is set.
	// Tested on a Mac with perlcritic v1.130, Perl v5.26.1.
	if (newSettings.additionalArguments.indexOf("--profile") === -1 && newSettings.additionalArguments.indexOf("-p") === -1) {
		newSettings.additionalArguments.push(`--${newSettings.severity}`);
	}

	newSettings.additionalArguments.push(`--top=${newSettings.maxNumberOfProblems}`);

	newSettings.additionalArguments = defaultSettings.additionalArguments
		.concat(newSettings.additionalArguments
			.filter(a => !a.match(/count|list|profile-proto|statistics-only|-C|pager|doc|verbose|quiet/)));

	return newSettings;

}

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	if (!globalSettings.onSave) {
		validateTextDocument(change.document);
	}
});

documents.onDidSave(change => {
	if (globalSettings.onSave)
		validateTextDocument(change.document);
})

function validate(text: string): Promise<Output> {
	if (text == "") {
		return Promise.resolve(new Output("", ""));
	}
	return new Promise(resolve => {
		try {
			let spawn = child_process.spawn;
			const executable = validateExecutable(globalSettings.executable);
			let worker = spawn(executable, globalSettings.additionalArguments);
			worker.stdin.write(text);
			worker.stdin.end();

			let outputStr = '';
			worker.stdout.on('data', (chunk) => {
				outputStr += chunk;
			});

			let errorStr = '';
			worker.stderr.on('data', (chunk) => {
				errorStr += chunk;
			});

			worker.stdout.on('end', () => {
				resolve(new Output(outputStr, errorStr));
			});
		}
		catch (error) {
			resolve(new Output('', error as string));
			return;
		}
	});
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	// In this simple example we get the settings for every validate run.
	// let settings = await getDocumentSettings(textDocument.uri);
	let output = await validate(textDocument.getText());

	if (output.error) {
		connection.window.showErrorMessage(output.error);
		return;
	}

	let diagnostics: Diagnostic[] = [];
	output.critiques.forEach((critique: Critique) => {
		let diagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Warning,
			range: {
				start: { line: critique.line, character: critique.column },
				end: { line: critique.line, character: Number.MAX_VALUE }
			},
			message: critique.summary,
			source: 'perlcritic'
		};
		if (hasDiagnosticRelatedInformationCapability) {
			diagnostic.relatedInformation = [
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range)
					},
					message: critique.explanation
				}
			];
		}
		diagnostics.push(diagnostic);

	});

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
