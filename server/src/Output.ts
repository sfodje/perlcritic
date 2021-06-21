

import Critique from './Critique';

export default class Output {
    error: string|undefined;
    critiques: Array<Critique> = [];

    constructor(outputStr: string, errorStr?: string) {
        if (errorStr) {
            this.error = errorStr;
            return;
        }
        if (!outputStr) return;

        outputStr.split(/\[\[END\]\]/).forEach((critiqueText: string) => {
            critiqueText = critiqueText.trim();
            // remove ANSI escape code
            critiqueText = critiqueText.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
            let critique = new Critique(critiqueText);

            if (critique.error) {
                this.error = critique.error;
                return;
            }

            if (critique.severity) this.critiques.push(new Critique(critiqueText));
        });

    }
}
