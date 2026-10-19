# Design notes

These notes record the decisions behind Duet. The agent sessions, the shared documents, and the conversation notes come from [Yami](https://github.com/nathanaday/yami); its `design.md` records those decisions and the harness behavior that the code depends on.

## What Duet is

Duet is an Obsidian plugin built on `yami`. It calls `createYami` from `yami/obsidian` with one agent for each profile, and adds no modules. Yami gives it the shared-document hub, the conversation notes with their commands and ribbon icon, the approval prompts, the status bar, the Stop and Undo commands, and the harness sessions of mentions. `yami/agent` starts and drives Claude Code and Codex sessions, with one event model for both.

Duet adds what is its own:

- **Mentions.** The user writes `@claude` and a request on a line of a note. The agent replies in a callout under the line. It can change only that note, through Duet's note tools.
- **Agent profiles.** The settings hold one profile for each tag: the harness, the program path, environment variables, the model, the effort, the approval setting, and the color. `plugin/src/agents.ts` turns a profile into a Yami agent and keeps it until the profile changes.
- **The contribution ledger and the lens.** They record and show which text a Duet agent wrote.
- **The API for other plugins.** `plugin.api` starts conversation notes.

Conversation notes carry `type: conversation`, as in every Yami plugin. New conversation notes go into the folder of the "Conversation folder" setting; the default is `conversations`.

## Mentions

### One conversation per note

Mentions use `yami.noteSessions`. Yami gives one harness session for each note and agent. It follows renames and removals, closes a session after the idle minutes with no turn, and starts a new session when the harness lost the stored one. Duet stores the ids that `save` gives in its plugin data. `setup` gets the note's `TFile`, and builds the state of each harness session from it: the agent's cursors, its note tools, and its reply queue. A new harness session gets new tools, which have seen nothing of the note. Forget the mention conversation calls `notes.forget`. A mention session starts with `skills: []`, so it gets no skill set of Yami.

Events reach the right reply through a queue: each mention adds a reply to its session's queue, and each `turn-start` takes the next one.

### Note tools

A mention session runs with `access: 'read-only'` and Duet's note tools `read_note`, `edit_note` and `write_note`, which run inside the plugin. The agent can read and search the vault, and can change only the note that it was asked in. A read-only session asks for nothing, so a mention has no permission handler. A mention agent types its edits by `yami.animate`, the same rule as a conversation.

Edits apply against the version of the note that the agent last read: the Yjs snapshot from the last `read_note`, or from the message that contained the note. Yami merges the edit into the current text, so what the user typed in the meantime stays.

The agent sees the note with the request line and its reply callout replaced by the line `⟦request and reply⟧`. Edits that overlap this line are cut around it, so the agent cannot change the request or its own reply.

### Writing a reply

The reply is a `LiveRegion` of the shared note, so it streams into the callout while the user keeps typing around it. The callout is rendered so that streamed text only appends. While the agent works, the agent's cursor shows its status; the callout does not.

### Turns the user did not ask for

Claude Code can run a command in the background and end its turn at once. When the command finishes, Claude Code starts a new turn by itself. A note has no place for that reply. Yami's Claude adapter sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for every Claude session, and the instructions ask both agents to wait for commands. A turn that starts without a mention still gets a "(follow-up)" callout at the end of the note.

### Agent tags

An editor extension shows each `@name` tag of a configured agent as a pill in the agent's color, like a `#tag`. It uses the same rules as the Enter trigger: `findTags` in `mention.ts` finds the tags, and tags in code, frontmatter, math, blockquotes and email addresses stay plain. The pill shows as soon as the name is complete, before the request, so the user sees that the tag will work. A Reading view post-processor wraps tags in the same pill.

## API for other plugins

A plugin such as Atlas starts a Duet conversation through `plugin.api` instead of running its own agents. `plugin/src/api.ts` holds the types and imports nothing, so another plugin can copy it. The `profile` option names a Duet agent by its tag, in any letter case; Duet passes the registered agent to `yami.conversations.start`, which creates the note and sends the first message. Yami reads the conversation folder setting at each call.

Duet passes each call to `yami.conversations`, which gives these guarantees:

- **The path is final at once.** The note is named when it is created, from `title` or from the message, so the first message does not rename it.
- **Status without a race.** The conversation is `working` when `newConversation` resolves. When a turn ends with a message in the queue, the next turn starts before the listeners run, so a listener sees `working`.
- **Listeners follow the note.** `onTurnEnd` keeps listeners by `TFile`, so a rename keeps them. An error in a listener goes to the console and does not stop the turn.

## Contribution ledger

The ledger records which text of each note a Duet agent wrote. The contribution lens shows it.

**What it records.** All text that a Duet agent writes into a shared note: its edits, its mention replies, and its parts of a conversation note. The only source is the `agent` of each change that `hub.observe` reports. A change with no agent, such as one by the user, Obsidian or the disk, means no agent. The ledger records no author for other text. A change by another program, such as an agent that Duet did not start, is not attributed. The ledger does not detect AI-written text.

**Current spans, not a log.** A position in an edit log is correct only for the text at the time of the edit. Every later edit above it moves the text. So the ledger keeps the current spans and moves them through each later change. Spans use character offsets, not line and column, because offsets move through a change with simple arithmetic.

**Whole words.** Character diffs match letters by chance. `# Welcome` → `# Hello from the agent` keeps the `e` and `l`, which would leave them to the user. So a change takes the whole words that it touches: the agent's change makes them the agent's, and any other change makes them no agent's. A letter deleted inside a word counts as a change to the word.

**Changes that Duet does not see.** A note changes while Obsidian is closed, through sync or in another editor. Each ledger file keeps the note text that its spans refer to. When Duet next reads the record, it compares that text with the note and moves the spans through the difference. Words that changed lose their attribution, so the result errs toward "not attributed". The copy of the text is updated at each change, so deleted text can stay in it until then.

**Exact while shared.** The ledger follows each change of a shared note through `hub.observe`: `shared`, then `changed` with the note, the text before the change, and the agent, then the stop. So the ledger keeps no copy of the text while the note is shared, and needs no comparison. The lens of an editor that shows a shared note maps the spans to the editor's text for display only. Only the shared note changes the record.

**Edits to closed notes in conversations.** In a conversation the agent edits files with its own tools. A change merges as the agent's edit only when the note is shared before the change. Yami's `beforeFileChange` runs before a file-editing tool; the conversation shares the named notes there, and the hub releases them when the turn ends. Claude Code runs it as a `PreToolUse` hook and waits for it. Codex waits only when it asks for approval; with the sandbox approval setting, it can apply a change before the note is shared, and that change is not attributed. A shell command that writes a file has no hook. A note that a conversation agent creates with its own tools is the agent's from the start.

**Storage.** One JSON file for each note at `.duet/contributions/<note path>.json`: `{ version, text, spans: [{ from, to, agent, time }] }`. The folder is hidden in Obsidian and moves with the vault in file-based sync. Obsidian Sync does not sync hidden folders. The files follow renames and deletes. A file with no spans left is removed. Saves wait one second after the last change.

**The lens.** In the editor, agent text has a mark with a tooltip that names the agent and the date. Live Preview renders some blocks, such as callouts and tables, as widgets, and a mark inside a widget does not show. A widget that holds agent text gets a bar on its left edge instead. Reading view has no source positions in its rendered text, so it marks whole sections.

## Settings

The settings tab uses the declarative settings API of Obsidian 1.13, so each setting shows in the settings search. Each agent is a group on the main page, with its tag as the heading and a remove button. Pages would hide the remove action: a list of pages has no visible delete button, and Obsidian finds an open page by its name, so renaming an agent while its page is open would empty the page. Every setting applies with no reload. `saveSettings` calls `yami.setAgents`. A profile whose options change, other than its tag and color, gets a new `Agent`, so Yami closes the old agent's sessions once their work ends. The conversation folder, the idle minutes, and Show agents typing are functions that Yami reads at each use. A changed tag renders the tab again only when the Tag field gives the focus to another element, not when the window loses the focus, because a render takes the focus and the typed keys from the field. A Remove button finds its profile when the person clicks it, not by the index of the first render, because Obsidian keeps the buttons of a group across renders. When the person removes every profile, Yami's conversation notes say what to do, and a profile that the person adds takes over the open notes with no reload.

"Load my MCP servers and plugins" sets the Claude agent's `settingSources`: with it, Claude Code reads the user's settings, and with it off, only the project's.

## Bundling

`scripts/plugin.mjs` bundles the plugin with `pluginBuild` from `yami/esbuild`, which holds the SDK fixes, and writes `styles.css` with `copyStyles`: Yami's stylesheet, then `plugin/styles.css`.

The unit tests import the text operations from `yami/document`, which loads no Obsidian, so they mock no `obsidian` class. Duet's `obsidian` and CodeMirror type packages must be the versions that `yami` uses, or TypeScript sees two sets of nominal types.

## Command ids

Yami's command ids start with `yami-`. Duet's own ids, `toggle-lens` and `forget-mentions`, never do. The README lists the ids that changed for users who set hotkeys.

## Vault files

`createYami` installs Yami's own files and gives each agent Yami's tools. Duet keeps every default.

| Part | Can Duet turn it off? |
| --- | --- |
| `Yami.base` in the vault root | No |
| `internal/yami/skills/run/SKILL.md` | No |
| `internal/wiki/` (12 files) | No: the wiki is built into Yami |
| Folder colors | Yes, `folderColors: false` |
| Session commands | Yes, `commands.sessions: false` |
| The wiki commands, and New module | Yes, `commands.wiki: false`, `commands.modules: false` |
| Yami's status bar, which shows mentions too | Yes, `statusBar: false` |
| Yami's tools and skill sets in every conversation agent | No |
| Yami's tools and skill sets in mention sessions | Duet leaves them out: `tools: noteTools, skills: []` in `setup` |

## Testing in a separate Obsidian

`test/obsidian/harness.ts` starts Obsidian with `--user-data-dir` set to a temporary profile and `--remote-debugging-port`, so it runs beside the user's own Obsidian and does not share its settings or vaults. Playwright connects over the Chrome DevTools Protocol and types into the editor as a user does. The harness enables the plugin once with `enablePluginAndSave`. If the plugin is also listed in `community-plugins.json`, turning on community plugins loads a second instance. After each test, the suite checks that every open shared note has the same text in the editor and in the document. A test that finds a conversation's message box finds it in the active leaf (`.workspace-leaf.mod-active .yami-composer`), because earlier conversation notes stay open in other tabs.

A new profile has no app update, so Obsidian would run the version that its installer contains, which can be older than the plugin's `minAppVersion`. The harness copies the newest `obsidian-<version>.asar` from Obsidian's own data folder into the test profile, so the tests run the version that the user runs. Obsidian ignores a symbolic link there. In Obsidian 1.14, the settings open in a separate window; a test that uses the settings waits for that window.

On macOS, Obsidian shows menus as native menus by default. Screenshots do not include them.

## Licensing and accounts

Duet does not include either harness. It runs the binary that the user installed, with the user's own login. The Claude Agent SDK package is not open source ("All rights reserved", under Anthropic's commercial terms). The plugin bundles the SDK's JavaScript but not its native binary. Anthropic's terms do not let a third-party product offer claude.ai subscription login unless Anthropic approves it. Read the current terms before you publish the plugin.
