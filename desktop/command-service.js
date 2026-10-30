import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import { parseCommandIntent } from '../src/commands/intent-parser.js';
import { searchMacFiles } from '../src/commands/mac-file-search.js';
import { resolveTarget } from '../src/commands/target-resolver.js';

const applicationNames = Object.freeze({ vscode: 'Visual Studio Code', terminal: 'Terminal' });

function runOpen(arguments_, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('/usr/bin/open', arguments_, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('macOS could not open that item.')));
  });
}

export async function executeOpenAction({ application, path }, { shell, spawnImpl = spawn } = {}) {
  if (!['vscode', 'finder', 'terminal', 'default'].includes(application)) throw new Error('Application is not supported.');
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error('The selected file or folder no longer exists.');
  if (application === 'finder' && !info.isDirectory()) {
    shell.showItemInFolder(path);
    return;
  }
  if (application === 'default' || application === 'finder') {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
    return;
  }
  await runOpen(['-a', applicationNames[application], path], spawnImpl);
}

// An invite sentence: filled in Outlook (or Google) by quick-invite.js, never sent. The answer is the readout lines,
// or a plain question when a name matches two people.
async function defaultInvite(text, { people = null, places = [] } = {}) {
  const { inviteFromSentence, describe } = await import('../src/hikyaku/quick-invite.js');
  try {
    const result = await inviteFromSentence(text, { ...(people ? { people } : {}), places });
    return { status: result.status === 'ready' ? 'invited' : 'invite_stopped', lines: describe(result) };
  } catch (error) {
    return { status: 'invite_question', message: error.message };
  }
}

// `invitePlaces()` gives it the places the user has used before (places.js), the same list the box previews with.
// `invitePeople()` gives the invite reader everyone the user can be matched to (the ask box's who index: saved threads
// plus every Outlook sender), so "invite yuki" finds Yuki from her email even with no saved thread.
export function createCommandService({ coreClient, shell, roots = [join(homedir(), 'Documents'), join(homedir(), 'Desktop'), join(homedir(), 'Downloads')], spawnImpl = spawn, invite = defaultInvite, invitePeople = null, invitePlaces = null, folderAccess, home = homedir(), searchMac = searchMacFiles }) {
  async function execute(text) {
    const intent = parseCommandIntent(text);
    if (intent.type === 'invite') return invite(intent.original, { people: invitePeople ? await invitePeople().catch(() => null) : null, places: invitePlaces ? await invitePlaces().catch(() => []) : [] });
    if (intent.type !== 'open') return intent;
    const standardFolders = { downloads: 'Downloads', download: 'Downloads', documents: 'Documents', desktop: 'Desktop', home: '' };
    const named = intent.target.toLowerCase().trim();
    if (Object.hasOwn(standardFolders, named)) {
      const path = join(home, standardFolders[named]);
      await executeOpenAction({ application: intent.application, path }, { shell, spawnImpl });
      return { status: 'completed', intent, target: { path, name: standardFolders[named] || 'Home' }, message: `Opened ${standardFolders[named] || 'Home'}.` };
    }
    const selectedRoots = folderAccess ? folderAccess.roots() : roots;
    if (intent.mode === 'search') {
      const result = await searchMac({ target: intent.target, extensions: intent.extensions, home, extraRoots: selectedRoots });
      const { candidates, blocked, limited } = result;
      const note = `${limited ? ' Search reached its time or result limit; these are the matches found so far.' : ''}${blocked.length ? ' macOS denied access to some locations.' : ''}`;
      if (!candidates.length) return { status: 'not_found', intent, ...result, message: `No accessible matches found for “${intent.target}”.${note}` };
      return { status: 'needs_choice', intent, ...result, message: `${result.related ? `No exact filename match for “${intent.target}”. Found` : 'Found'} ${candidates.length} ${result.related ? 'possible' : 'matching'} file${candidates.length === 1 ? '' : 's'} on this Mac. Select one to reveal it in Finder.${note}` };
    }
    const searchRoots = selectedRoots;
    if (!searchRoots.length) return { status: 'access_needed', message: 'Choose the folders Loggie can search in Connections, then try your request again.' };
    const diagnostics = [];
    const candidates = await resolveTarget({ diagnostics, target: intent.target, extensions: intent.extensions, maxResults: intent.mode === 'search' ? Infinity : 8, projects: await coreClient.listProjects(), roots: searchRoots });
    if (!candidates.length && diagnostics.length) return { status: 'access_needed', message: 'macOS blocked access to some folders. Re-select them in Connections. If access remains blocked, allow Loggie in System Settings → Privacy & Security → Files and Folders.', blocked: diagnostics };
    if (!candidates.length) return { status: 'not_found', intent, message: `I couldn’t find “${intent.target}” in your selected folders. Choose its parent folder in Connections to search elsewhere.` };
    if (intent.mode === 'search') return { status: 'needs_choice', intent, candidates, message: `Found ${candidates.length} matching file${candidates.length === 1 ? '' : 's'}. Select one to reveal it in Finder.${diagnostics.length ? ' Some folders could not be read.' : ''}`, blocked: diagnostics };
    const best = candidates[0];
    const similarlyRanked = candidates.filter((candidate) => candidate.score >= best.score - 5);
    if (similarlyRanked.length > 1) return { status: 'needs_choice', intent, message: `I found ${similarlyRanked.length} matches for “${intent.target}”.`, candidates: similarlyRanked };
    await executeOpenAction({ application: intent.application, path: best.path }, { shell, spawnImpl });
    return { status: 'completed', intent, target: best, message: `Opened ${best.name} in ${intent.applicationLabel}.` };
  }

  async function openResolved({ application, path }) {
    await executeOpenAction({ application, path }, { shell, spawnImpl });
    return { status: 'completed', target: { path, name: path.split('/').at(-1) }, message: `Opened ${path.split('/').at(-1)}.` };
  }

  return { execute, openResolved };
}
