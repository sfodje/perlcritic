/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	createConnection,
	TextDocuments,
	TextDocument,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
} from 'vscode-languageserver';

import * as child_process from 'child_process';
import Critique from './Critique';
import Output from './Output';
import * as which from 'which';


// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we will fall back using global settings
	hasConfigurationCapability =
		capabilities.workspace && !!capabilities.workspace.configuration;
	hasWorkspaceFolderCapability =
		capabilities.workspace && !!capabilities.workspace.workspaceFolders;
	hasDiagnosticRelatedInformationCapability =
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation;

	return {
		capabilities: {
			textDocumentSync: documents.syncKind,
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
	executable: validateExecutable("perlcritic"),
	severity: "gentle",
	onSave: false,
	additionalArguments: ['--quiet', ["--verbose", "%l[>]%c[>]%s[>]%m. %e (%p)[>]%d[[END]]"].join('=')]
};
let globalSettings: PerlcriticSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<PerlcriticSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	try {
		globalSettings = mergeSettings(change.settings.perlcritic);
	} catch (error) {
		// do nada
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function validateExecutable(executable: string): string {
	try {
		return which.sync(executable);
	}
	catch (error) {
		connection.window.showErrorMessage(error);
		return "";
	}
}

function mergeSettings(newSettings: PerlcriticSettings): PerlcriticSettings {
	if (!newSettings) {
		return defaultSettings;
	}

	newSettings.executable = validateExecutable(newSettings.executable);

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

/*function getDocumentSettings(resource: string): Thenable<PerlcriticSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'perlcritic'
		});
		documentSettings.set(resource, result);
	}
	return result;
}*/

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

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
		return new Promise(resolve => {
			resolve(new Output("", ""))
		});
	}
	return new Promise(resolve => {
		try {
			let spawn = child_process.spawn;
			let worker = spawn(globalSettings.executable, globalSettings.additionalArguments);
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
			resolve(new Output('', error));
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

/*
connection.onDidOpenTextDocument((params) => {
	// A text document got opened in VSCode.
	// params.uri uniquely identifies the document. For documents store on disk this is a file URI.
	// params.text the initial full content of the document.
	connection.console.log(`${params.textDocument.uri} opened.`);
});
connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});
connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.uri uniquely identifies the document.
	connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
