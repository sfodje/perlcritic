'use strict';

import {
	IPCMessageReader, IPCMessageWriter,
	createConnection, IConnection, TextDocumentSyncKind,
	TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
	InitializeParams, InitializeResult, TextDocumentPositionParams,
	CompletionItem, CompletionItemKind
} from 'vscode-languageserver';
import * as which from 'which';
import * as child_process from 'child_process';
import * as path from 'path';

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
let workspaceRoot: string;
connection.onInitialize((params): InitializeResult => {
	workspaceRoot = params.rootPath;
	return {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: documents.syncKind
		}
	};
});

// The settings interface describe the server relevant settings part
interface ISettings {
	perlcritic: PerlCriticSettings;
}

// These are the example settings we defined in the client's package.json
// file
interface PerlCriticSettings {
	maxNumberOfProblems: number;
	executable: string;
	severity: string;
	additionalArguments: Array<string>;
}

class Settings {
	executable: string;
	options: Array<string> = ['--quiet', ["--verbose", "%l[>]%c[>]%s[>]%m. %e[>]%d[[END]]"].join('=')];

	constructor(settings?: ISettings) {
		if (!settings) {
			return;
		}
		let maxNumberOfProblems = settings.perlcritic.maxNumberOfProblems || 10;
		let severity = settings.perlcritic.severity;

		try {
			this.executable = which.sync(settings.perlcritic.executable || 'perlcritic');
		}
		catch (error) {
			connection.window.showErrorMessage(error);
		}

		this.options = this.options.concat(settings.perlcritic.additionalArguments || []).filter((v) => {
			if (!v.match(/count|list|profile-proto|statistics-only|-C|pager|doc/)) {
				return v;
			}
		});
		this.options.push('--' + severity);
		this.options.push('--top=' + maxNumberOfProblems);
	}
}

class Critique {
	line: number;
	column: number;
	severity: number;
	summary: string;
	explanation: string;
	error: string;

	constructor(outputText: string) {
		if (!outputText) return;

		let line, column, severity, summary, explanation;
		[line, column, severity, summary, explanation] = outputText.split(/\[>\]/);

		// invalid output if line, column and severity are not numbers
		if (isNaN(line) || isNaN(column) || isNaN(severity)) {
			this.error = "Invalid output format (Please check your perltidy settings): " + outputText;
			return;
		}

		line = parseInt(line.trim());
		column = parseInt(column.trim());
		severity = parseInt(severity.trim());

		this.line = line > 0 ? parseInt(line) - 1 : 0;
		this.column = column > 0 ? parseInt(column) - 1 : 0;
		this.severity = severity > 0 ? parseInt(severity) - 1 : 0;
		this.summary = summary.trim();
		this.explanation = explanation.trim();
		return;
	}
}

class Output {
	error: string;
	critiques: Array<Critique> = [];

	constructor(outputStr: string, errorStr?: string) {
		if (errorStr) {
			this.error = errorStr;
			return;
		}
		if (!outputStr) return;

		outputStr.split(/\[\[END\]\]/).forEach((critiqueText: string, i: number) => {
			critiqueText = critiqueText.trim();
			let critique = new Critique(critiqueText);

			if (critique.error) {
				this.error = critique.error;
				return;
			}

			if (critique.severity) this.critiques.push(new Critique(critiqueText));
		});

	}
}

// hold the settings
let settings: Settings = new Settings();
// The settings have changed. Is send on server activation
// as well.

connection.onDidChangeConfiguration((change) => {
	settings = new Settings(change.settings);

	// Revalidate any open text documents
	documents.all().forEach(validateTextDocument);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
	validateTextDocument(change.document);
});

documents.onDidClose((change) => {
	let diagnostics = [];
	connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
});

function validate(textDocument: TextDocument): Promise<Output> {

	return new Promise((resolve, reject) => {
		try {
			let spawn = child_process.spawn;
			let worker = spawn(settings.executable, settings.options);
			worker.stdin.write(textDocument.getText());
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
			resolve(new Output('', "Some error"));
			return;
		}
	});
}

function validateTextDocument(textDocument: TextDocument): void {
	validate(textDocument)
		.then((output: Output) => {
			let diagnostics: Diagnostic[] = [];
			if (output.error) {
				connection.window.showErrorMessage(output.error);
				return;
			}

			output.critiques.forEach((critique: Critique, i: number) => {
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					range: {
						start: { line: critique.line, character: critique.column },
						end: { line: critique.line, character: Number.MAX_VALUE }
					},
					message: critique.summary + ".\n\n> " + critique.explanation,
					source: 'perlcritic'
				});
			});

			// Send the computed diagnostics to VSCode.
			connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
		});
}

let t: Thenable<string>;

// Listen on the connection
connection.listen();