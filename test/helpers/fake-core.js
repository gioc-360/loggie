// The in-memory Cores the tests pass in place of src/core, one per shape that was pasted into the test files. Where
// the copies differed (id prefixes, what a brief hands back, what the session list holds) the difference is an
// option, so each test still proves exactly what its own copy proved.

// Core's own task transitions: a run that skips a step fails here as it would against the real Core.
const ALLOWED = { waiting: ['briefed'], briefed: ['waiting', 'running'], running: ['waiting', 'blocked', 'done'], blocked: ['waiting', 'running', 'done'], done: ['waiting'] };

// What createBrief keeps and hands back, by the copy it came from.
const BRIEFS = {
  // the brief Core would return: its id, the task and every field (chats, cloud-screen)
  kept: (briefs, taskId, input) => { const brief = { id: `brief_${briefs.length + 1}`, taskId, ...input }; briefs.push(brief); return brief; },
  // only the id comes back (calls)
  id: (briefs, taskId, input) => { briefs.push({ taskId, ...input }); return { id: `brief_${briefs.length}` }; },
  // a draft brief to approve later; the kept record is keyed by the task id (intros)
  draft: (briefs, taskId, input) => { briefs.push({ id: taskId, ...input }); return { id: 'brief_1', status: 'draft' }; },
  // nothing kept (meetings-refile)
  stub: () => ({ id: 'brief' }),
};

// Projects, tasks and briefs in arrays the test reads back. `finders` adds getProject/getTask; `brief` names a
// BRIEFS entry and adds createBrief; `status: null` makes tasks with no status of their own.
export function storeCore({ projects = [], projectId = (n) => `project_${n}`, taskId = (n) => `task_${n}`, status = 'waiting', brief = null, finders = false } = {}) {
  const tasks = [], briefs = [];
  const core = {
    projects, tasks, briefs,
    listProjects: async () => projects, listTasks: async () => tasks,
    createProject: async (input) => { const project = { id: projectId(projects.length + 1), ...input }; projects.push(project); return project; },
    createTask: async (input) => { const task = { id: taskId(tasks.length + 1), ...(status && { status }), ...input }; tasks.push(task); return task; },
  };
  if (brief) core.createBrief = async (id, input) => BRIEFS[brief](briefs, id, input);
  if (finders) Object.assign(core, { getProject: async (id) => projects.find((item) => item.id === id), getTask: async (id) => tasks.find((item) => item.id === id) });
  return core;
}

// Records each call a headless run makes, in order, as [name, ...args]. `sessions` is what listSessions finds,
// `sessionId` what createSession returns and `approved` what getApprovedBrief returns.
export function recordingCore({ sessions = [], sessionId = 'session_1', approved = { id: 'brief_1' } } = {}) {
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); return name === 'createSession' ? { id: sessionId } : name === 'getApprovedBrief' ? { ...approved } : {}; };
  return { calls, listSessions: async () => sessions.map((session) => ({ ...session })), getApprovedBrief: record('getApprovedBrief'), createSession: record('createSession'), transitionSession: record('transitionSession'), transitionTask: record('transitionTask'), createWriteUp: record('createWriteUp') };
}

// One task that moves only along ALLOWED, in project p1 at core.directoryPath (read on each call, so a test may set it
// after). `brief: 'draft'` starts unapproved until approveBrief; `sessions: false` leaves out the session methods.
// `calls` logs each transition asked for; `sessions` keeps what createSession was given, numbering s1, s2, ...
export function taskCore(task, { directoryPath = null, brief = 'approved', sessions = true } = {}) {
  const calls = [], made = [];
  const kept = brief === 'draft' ? { id: 'brief_1', status: 'draft' } : null;
  const core = {
    task, calls, sessions: made, directoryPath,
    getTask: async () => ({ ...task }),
    getProject: async () => ({ id: 'p1', directoryPath: core.directoryPath }),
    getApprovedBrief: async () => (kept ? (kept.status === 'approved' ? kept : null) : { id: 'brief_1' }),
    getLatestBrief: async () => kept || { id: 'brief_1', status: 'approved' },
    approveBrief: async () => { if (!kept) return {}; kept.status = 'approved'; return kept; },
    transitionTask: async (id, to) => {
      calls.push(['transitionTask', to]);
      if (!ALLOWED[task.status].includes(to)) throw new Error(`Core refuses ${task.status} -> ${to}`);
      task.status = to;
      return { ...task };
    },
  };
  if (sessions) Object.assign(core, {
    listSessions: async () => [],
    createSession: async (input) => { made.push(input); return { id: `s${made.length}` }; },
    transitionSession: async () => ({}),
    createWriteUp: async () => ({}),
  });
  return core;
}
