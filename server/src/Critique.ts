export default class Critique {
    line: number;
    column: number;
    severity: number;
    summary: string;
    explanation: string;
    error: string;

    constructor(outputText: string) {
        if (!outputText) return;

        let lineStr, columnStr, severityStr, summaryStr, explanationStr;
        [lineStr, columnStr, severityStr, summaryStr, explanationStr] = outputText.split(/\[>\]/);

        // invalid output if line, column and severity are not numbers
        if (!this.isNumber(lineStr) || !this.isNumber(columnStr) || !this.isNumber(severityStr)) {
            this.error = "Invalid output format (Please check your perltidy settings): " + outputText;
            return;
        }

        let lineInt = parseInt(lineStr.trim());
        let columnInt = parseInt(columnStr.trim());
        let severityInt = parseInt(severityStr.trim());

        this.line = lineInt > 0 ? lineInt - 1 : 0;
        this.column = columnInt > 0 ? columnInt - 1 : 0;
        this.severity = severityInt > 0 ? severityInt - 1 : 0;
        this.summary = summaryStr.trim();
        this.explanation = explanationStr.trim();
        return;
    }

    private isNumber(n: any) {
        return !isNaN(parseInt(n)) && isFinite(n);
    }
}
