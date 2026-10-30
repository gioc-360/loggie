import { readWords } from '../hikyaku/wordmap.js';
const applicationAliases = Object.freeze([
  { id: 'vscode', label: 'Visual Studio Code', aliases: ['visual studio code', 'vs code', 'vscode', 'code'] },
  { id: 'finder', label: 'Finder', aliases: ['finder', '檔案總管'] },
  { id: 'terminal', label: 'Terminal', aliases: ['terminal', '終端機', '終端'] },
]);

function detectApplication(text) {
  const lowered = text.toLowerCase();
  return applicationAliases.find((application) => application.aliases.some((alias) => lowered.includes(alias))) || null;
}

export function parseCommandIntent(input) {
  if (typeof input !== 'string' || !input.trim()) return { type: 'invalid', message: 'Tell Loggie what you want to do.' };
  const original = input.trim();
  // File location questions stay local; an Excel description constrains the file type.
  const sentence = original.replace(/^(?:hey\s+)?loggie[,!:]?\s*/i, '').replace(/^(?:(?:please|can you|could you|help me)\s+)+/i, '');
  const finding = sentence.match(/^(?:where (?:is|are)(?:\s+located)?|find|locate|search for|look for)\s+(.+?)[?!]*$/i);
  if (finding && (/\b(?:file|folder|excel|spreadsheet|workbook|pdf|document)\b|\.[a-z0-9]{2,5}\b/i.test(finding[1]))) {
    const extensions = /\b(?:excel|spreadsheet|workbook)\b/i.test(finding[1]) ? ['.xlsx', '.xls', '.xlsm', '.xlsb'] : /\bpdf\b/i.test(finding[1]) ? ['.pdf'] : [];
    const description = finding[1].replace(/(?:\s*[,;]\s*|\s+(?:and|then)\s+|\s+)(?:please\s+)?(?:open|show|reveal)\s+(?:it|them)(?:\s+please)?[.!?]*$/i, '').replace(/[.!?]+$/g, '').trim();
    const target = description.replace(/^(?:(?:my|the|a|an|all)\s+)+/i, '').replace(/\s+(?:excel|spreadsheet|workbook|pdf)(?:\s+files?)?$/i, '').replace(/\s+(?:files?|folder|document)$/i, '').replace(/[?!]+$/g, '').trim();
    if (target) return { type: 'open', mode: 'search', target, extensions, application: 'finder', applicationLabel: 'Finder', original };
  }
  // An invite or a meeting goes to quick-invite.js, which reads the whole sentence itself.
  if (/\b(?:invite|invitation|schedule|set up (?:a |the )?(?:meeting|call)|book (?:a |the )?(?:meeting|room)|meeting with)\b/i.test(original)) return { type: 'invite', original };
  const isOpen = /(?:打開|開啟|开启|open|show|reveal)/iu.test(original);
  // No invite word, but the word map reads one: the kind of meeting or a time with someone ("lunch with lena friday",
  // "tomorrow 5pm lena at maplewood"). The ask box shows it as an invite, so it runs as one.
  if (!isOpen && readWords(original).action === 'invite') return { type: 'invite', original, inferred: true };
  if (!isOpen) return { type: 'unsupported', original };

  const application = detectApplication(original);
  let target = original
    .replace(/^(?:hey\s+)?loggie[,!:]?\s*/i, '')
    .replace(/^(?:(?:please|can you|could you|would you|will you|help me|i need to|i want to|i would like to)\s+)+/i, '');
  if (application) {
    const lowered = target.toLowerCase();
    const alias = [...application.aliases].sort((a, b) => b.length - a.length).find((candidate) => lowered.includes(candidate));
    const index = alias ? lowered.indexOf(alias) : -1;
    if (index >= 0) target = `${target.slice(0, index)} ${target.slice(index + alias.length)}`;
  }
  target = target
    .replace(/(?:請|请|麻煩|麻烦|幫我|帮我|可以|能不能)/gu, ' ')
    .replace(/(?:打開|開啟|开启|open|show|reveal)/giu, ' ')
    .replace(/(?:在|於|于|用|中|裡|里)\s*/gu, ' ')
    .replace(/\b(?:with|using|in)\b/giu, ' ')
    .trim()
    .replace(/\s+(?:for me|please)[.!?]*$/iu, '')
    .replace(/[.!?]+$/u, '')
    .replace(/(?:這個|这个)?(?:檔案|文件|資料夾|文件夹|專案|项目|\s+(?:project|folder|file))$/giu, ' ')
    .trim()
    .replace(/^(?:(?:my|the|a|an)\s+)+/iu, '')
    .replace(/[「」“”"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!target) return { type: 'invalid', message: 'Tell Loggie which file, folder, or project to open.' };
  return { type: 'open', ...(/\bfolder\b/i.test(original) ? { mode: 'search', extensions: [] } : {}), application: application?.id || 'default', applicationLabel: application?.label || 'the default app', target, original };
}
