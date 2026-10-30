const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('loggie', Object.freeze({
  minimizePanel: () => ipcRenderer.invoke('loggie:minimize-panel'),
  toggleFullScreen: () => ipcRenderer.invoke('loggie:toggle-full-screen'),
  permissions: Object.freeze({ openSettings: permission => ipcRenderer.invoke('permissions:settings', permission) }),
  folders: Object.freeze({ allowDefaults: () => ipcRenderer.invoke('folders:allow-defaults'), status: () => ipcRenderer.invoke('folders:status'), choose: () => ipcRenderer.invoke('folders:choose') }),
  voice: Object.freeze({ authorize: () => ipcRenderer.invoke('voice:authorize'), start: () => ipcRenderer.invoke('loggie:start-dictation'), stop: () => ipcRenderer.invoke('loggie:stop-dictation'), onUpdate: listener => { const handler = (_e, data) => listener(data); ipcRenderer.on('loggie:voice', handler); return () => ipcRenderer.removeListener('loggie:voice', handler); } }),
  onFocusComposer: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('loggie:focus-composer', handler);
    return () => ipcRenderer.removeListener('loggie:focus-composer', handler);
  },
  hide: () => ipcRenderer.invoke('loggie:hide'),
  ask: Object.freeze({
    preview: (text) => ipcRenderer.invoke('ask:preview', text),
    run: (text, choices, cloud) => ipcRenderer.invoke('ask:run', text, choices, cloud),
    stop: (askId) => ipcRenderer.invoke('ask:stop', askId),
    undo: (askId) => ipcRenderer.invoke('ask:undo', askId),
    fill: (askId, time) => ipcRenderer.invoke('ask:fill', askId, time),
    again: (askId) => ipcRenderer.invoke('ask:again', askId),
    onStep: (listener) => { const handler = (_event, data) => listener(data); ipcRenderer.on('ask:step', handler); return () => ipcRenderer.removeListener('ask:step', handler); },
    onDone: (listener) => { const handler = (_event, data) => listener(data); ipcRenderer.on('ask:done', handler); return () => ipcRenderer.removeListener('ask:done', handler); },
    onDraft: (listener) => { const handler = (_event, data) => listener(data); ipcRenderer.on('ask:draft', handler); return () => ipcRenderer.removeListener('ask:draft', handler); },
  }),
  command: Object.freeze({
    execute: (text) => ipcRenderer.invoke('command:execute', text),
    openResolved: (selection) => ipcRenderer.invoke('command:open-resolved', selection),
  }),
  core: Object.freeze({
    onEvents: (listener) => {
      const handler = (_event, events) => listener(events);
      ipcRenderer.on('core:events', handler);
      return () => ipcRenderer.removeListener('core:events', handler);
    },
  }),
  hikyaku: Object.freeze({
    onMoved: (listener) => {
      const handler = (_event, outcome) => listener(outcome);
      ipcRenderer.on('hikyaku:moved', handler);
      return () => ipcRenderer.removeListener('hikyaku:moved', handler);
    },
    onRanked: (listener) => {
      const handler = () => listener();
      ipcRenderer.on('hikyaku:ranked', handler);
      return () => ipcRenderer.removeListener('hikyaku:ranked', handler);
    },
    openDraft: (taskId, options) => ipcRenderer.invoke('hikyaku:open-draft', taskId, options),
    answer: (taskId, text) => ipcRenderer.invoke('hikyaku:answer', taskId, text),
    draftAll: (taskIds) => ipcRenderer.invoke('hikyaku:draft-all', taskIds),
    openReplies: () => ipcRenderer.invoke('hikyaku:open-replies'),
    workstreams: () => ipcRenderer.invoke('hikyaku:workstreams'),
    catchUp: (name) => ipcRenderer.invoke('hikyaku:catch-up', name),
    refresh: () => ipcRenderer.invoke('hikyaku:refresh'),
    workspaceLook: (name) => ipcRenderer.invoke('hikyaku:workspace-look', name),
    workspaceNew: (name, keys) => ipcRenderer.invoke('hikyaku:workspace-new', name, keys),
    refreshOne: (name) => ipcRenderer.invoke('hikyaku:refresh-one', name),
    uiAct: (act) => ipcRenderer.invoke('hikyaku:ui-act', act),
    answerAsk: (id, workstream) => ipcRenderer.invoke('hikyaku:answer-ask', id, workstream),
    setStake: (name, stake) => ipcRenderer.invoke('hikyaku:set-stake', name, stake),
    park: (name, until) => ipcRenderer.invoke('hikyaku:park', name, until),
    renameWorkstream: (name, label) => ipcRenderer.invoke('hikyaku:rename-workstream', name, label),
    dismissWorkstream: (name) => ipcRenderer.invoke('hikyaku:dismiss-workstream', name),
    retireWorkstream: (name, choice, target) => ipcRenderer.invoke('hikyaku:retire-workstream', name, choice, target),
    unretireWorkstream: (name) => ipcRenderer.invoke('hikyaku:unretire-workstream', name),
    deleteWorkstream: (name, choice, target) => ipcRenderer.invoke('hikyaku:delete-workstream', name, choice, target),
    retiredWorkstreams: () => ipcRenderer.invoke('hikyaku:retired-workstreams'),
    moveThread: (itemId, workstream) => ipcRenderer.invoke('hikyaku:move-thread', itemId, workstream),
    setGoal: (name, goal) => ipcRenderer.invoke('hikyaku:set-goal', name, goal),
    confirmGoal: (name, text) => ipcRenderer.invoke('hikyaku:confirm-goal', name, text),
    rank: () => ipcRenderer.invoke('hikyaku:rank'),
    usage: () => ipcRenderer.invoke('hikyaku:usage'),
    firstToday: () => ipcRenderer.invoke('hikyaku:first-today'),
    notThis: (taskId) => ipcRenderer.invoke('hikyaku:not-this', taskId),
    cloud: () => ipcRenderer.invoke('hikyaku:cloud'),
    setCloud: (name, value) => ipcRenderer.invoke('hikyaku:set-cloud', name, value),
    doIt: (taskId, agent, line) => ipcRenderer.invoke('hikyaku:do-it', taskId, agent, line),
    replyTo: (taskId, line, cloud) => ipcRenderer.invoke('hikyaku:reply-to', taskId, line, cloud ?? null),
    replyYes: () => ipcRenderer.invoke('hikyaku:reply-yes'),
    setReplyYes: (what) => ipcRenderer.invoke('hikyaku:reply-yes-set', what),
    replyFill: (taskId, askId, time) => ipcRenderer.invoke('hikyaku:reply-fill', taskId, askId, time),
    replyAgain: (taskId, askId) => ipcRenderer.invoke('hikyaku:reply-again', taskId, askId),
    unretire: (taskId) => ipcRenderer.invoke('hikyaku:unretire', taskId),
    markMove: (taskId, why) => ipcRenderer.invoke('hikyaku:move-mark', taskId, why),
    moveDate: (taskId, date) => ipcRenderer.invoke('hikyaku:move-date', taskId, date),
    calls: () => ipcRenderer.invoke('hikyaku:calls'),
    events: (from, to) => ipcRenderer.invoke('hikyaku:events', from, to),
    fileEvent: (id, start, workstream) => ipcRenderer.invoke('hikyaku:file-event', id, start, workstream),
    eventSeed: (id, start) => ipcRenderer.invoke('hikyaku:event-seed', id, start),
    workspaceFromEvent: (id, start, name) => ipcRenderer.invoke('hikyaku:workspace-from-event', id, start, name),
    call: (id) => ipcRenderer.invoke('hikyaku:call', id),
    callLive: (id) => ipcRenderer.invoke('hikyaku:call-live', id),
    recordStart: (title, source, workspace, eventId, alsoEventId) => ipcRenderer.invoke('hikyaku:record-start', title, source, workspace, eventId, alsoEventId),
    callNotes: (id, text) => ipcRenderer.invoke('hikyaku:call-notes', id, text),
    fileCall: (id, workstream, source) => ipcRenderer.invoke('hikyaku:file-call', id, workstream, source),
    // Right-click (2026-10-28): the Mac's menu from item ids, its pick back; Share a call's notes; Delete recording.
    contextMenu: (menu) => ipcRenderer.invoke('hikyaku:context-menu', menu),
    callShare: (id, how) => ipcRenderer.invoke('hikyaku:call-share', id, how),
    callTrash: (id) => ipcRenderer.invoke('hikyaku:call-trash', id),
    nameAccept: (id, heard) => ipcRenderer.invoke('hikyaku:name-accept', id, heard),
    nameKeep: (id, heard) => ipcRenderer.invoke('hikyaku:name-keep', id, heard),
    nameUndo: (id, heard) => ipcRenderer.invoke('hikyaku:name-undo', id, heard),
    summarize: (id) => ipcRenderer.invoke('hikyaku:summarize', id),
    transcriptLine: (id, index, text) => ipcRenderer.invoke('hikyaku:transcript-line', id, index, text),
    searchCalls: (query) => ipcRenderer.invoke('hikyaku:search-calls', query),
    noteLine: (id, text, action, value) => ipcRenderer.invoke('hikyaku:note-line', id, text, action, value),
    explainCall: (id) => ipcRenderer.invoke('hikyaku:explain-call', id),
    callTitle: (id, title, choice) => ipcRenderer.invoke('hikyaku:call-title', id, title, choice),
    callMeetings: (id) => ipcRenderer.invoke('hikyaku:call-meetings', id),
    themName: (id, name) => ipcRenderer.invoke('hikyaku:them-name', id, name),
    sends: () => ipcRenderer.invoke('hikyaku:sends'),
    nextMeeting: () => ipcRenderer.invoke('hikyaku:next-meeting'),
    invite: (call, fields) => ipcRenderer.invoke('hikyaku:invite', call, fields),
    skipNextMeeting: (call) => ipcRenderer.invoke('hikyaku:skip-next-meeting', call),
    decide: (run, decision) => ipcRenderer.invoke('hikyaku:decide', run, decision),
    send: (run, provider, remember) => ipcRenderer.invoke('hikyaku:send', run, provider, remember),
    pick: (taskId, choice) => ipcRenderer.invoke('hikyaku:pick', taskId, choice),
    // A meeting offer's answer (meeting.offered): record starts the recording, dismiss only records the answer.
    meetingAnswer: (offerId, answer) => ipcRenderer.invoke('hikyaku:meeting-answer', offerId, answer),
    // The end ask's answer (meeting.end_asked): stop ends the recording and writes it up, keep only records the answer.
    meetingEnd: (call, answer) => ipcRenderer.invoke('hikyaku:meeting-end', call, answer),
    // Pause or resume the recording: the same recording goes on, with silence over the paused minutes.
    meetingPause: (call, answer) => ipcRenderer.invoke('hikyaku:meeting-pause', call, answer),
    // A page tucked into the recording: picked from the fusen tab (the open panel is main's), or a file dropped on the
    // card, whose path only the preload can read (webUtils); the page never sees it.
    callPagePick: (call, where) => ipcRenderer.invoke('hikyaku:call-page-pick', call, where),
    callPageAdd: (call, file, where) => ipcRenderer.invoke('hikyaku:call-page-add', call, webUtils.getPathForFile(file), where),
    // The same for a meeting not started yet: held under its occurrence (event id and start) until Record.
    eventPagePick: (eventId, start) => ipcRenderer.invoke('hikyaku:event-page-pick', eventId, start),
    eventPageAdd: (eventId, start, file) => ipcRenderer.invoke('hikyaku:event-page-add', eventId, start, webUtils.getPathForFile(file)),
    // Setup cards: "Open Settings" (open) or "Not now" (later) on a permission; Yes (yes) or Not now (later) on a cloud yes.
    setupAnswer: (permission, answer) => ipcRenderer.invoke('hikyaku:setup-answer', permission, answer),
    cloudYesAnswer: (group, answer) => ipcRenderer.invoke('hikyaku:cloud-yes-answer', group, answer),
    // The cloud AI key: save it in the keychain (the reply never holds it), say whether one is saved, test it once.
    saveKey: (key) => ipcRenderer.invoke('hikyaku:save-key', key),
    keyStatus: () => ipcRenderer.invoke('hikyaku:key-status'),
    testKey: () => ipcRenderer.invoke('hikyaku:test-key'),
    // The nine-step setup page: its status, its saves, what a step asks macOS for, the Tavily key, and Quit & Reopen.
    setupStatus: (part) => ipcRenderer.invoke('hikyaku:setup-status', part),
    setupSave: (patch) => ipcRenderer.invoke('hikyaku:setup-save', patch),
    availabilitySettings: () => ipcRenderer.invoke('hikyaku:availability-settings'),
    setAvailability: (patch) => ipcRenderer.invoke('hikyaku:set-availability', patch),
    recordCalendars: () => ipcRenderer.invoke('hikyaku:record-calendars'),
    setRecordCalendars: (ids) => ipcRenderer.invoke('hikyaku:set-record-calendars', ids),
    setupAsk: (what) => ipcRenderer.invoke('hikyaku:setup-ask', what),
    saveTavilyKey: (key) => ipcRenderer.invoke('hikyaku:save-tavily-key', key),
    testTavilyKey: () => ipcRenderer.invoke('hikyaku:test-tavily-key'),
    relaunch: () => ipcRenderer.invoke('hikyaku:relaunch'),
    appIcon: (app) => ipcRenderer.invoke('hikyaku:app-icon', app),
    // The Found step (first-run-polish B4.5): what the look found, a look now, and Keep or Later in one write.
    foundStatus: () => ipcRenderer.invoke('hikyaku:found-status'),
    foundLook: () => ipcRenderer.invoke('hikyaku:found-look'),
    foundKeep: (choice) => ipcRenderer.invoke('hikyaku:found-keep', choice),
    foundRead: (name) => ipcRenderer.invoke('hikyaku:found-read', name),
    // The event contract (docs/hikyaku-events.md): every new event as it is written, and one run's events whole.
    onEntry: (listener) => {
      const handler = (_event, entry) => listener(entry);
      ipcRenderer.on('hikyaku:entry', handler);
      return () => ipcRenderer.removeListener('hikyaku:entry', handler);
    },
  }),
}));
