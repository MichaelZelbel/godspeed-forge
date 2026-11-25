---
name: forge
description: The Forge, which builds the owner's GitHub projects with an AI software factory and makes a release public only on their go. Use it first for a short message with no other context, such as "go", "yes", "take it back" or one that starts with a handle like F7, whenever .godspeed/forge/waiting.json lists something: the Forge sent the owner a message the chat may not have seen, and this is the answer. Also use when the owner asks to plan a release ("plan release my-app", "plan the next my-app release", "what should go into the next version?"); says "go", "make it public", "take it back", "release status", "where is the release?" or asks in any words how the next version of one of their projects is coming along; says "turn on automatic work", "pause the factory" or "run one lap"; asks where to watch the factory at work ("where can I watch the factory?", "show me the factory working", "where do I see the laps?"); replies to a Forge question (a message that starts with a Forge handle such as F7, or a bare answer when .godspeed/forge/waiting.json shows exactly one question waiting); or asks to set up the Forge, or replies to a setup the Forge is running in this chat (.godspeed/forge/setup.json exists).
---

# The Forge

The Forge is an add-on on this server. It has an AI software factory build the owner's projects on GitHub one
release at a time, brings them the questions only they can answer, puts each finished release where they can try
it, and makes it public only when they say go. It runs on the server beside Godspeed; you talk to it through files
in the mission control folder, under `.godspeed/forge/`.

## First, read what the Forge knows

**A short reply with nothing before it is usually for the Forge.** The Forge sends its messages (a version ready to try, a
question) straight to the owner, so they may not be in this chat. When the owner writes only "go", "yes", "take it
back" or a handle such as F7, read `.godspeed/forge/waiting.json` before anything else: if it lists something that
the message answers, it is a Forge request, below.

Before you answer, read these files in the mission control folder:

- `.godspeed/forge/waiting.json`: what the Forge is waiting for from the owner. It lists the questions it asked
  (each with a short handle such as F7, its project and what it asked) and the releases that wait for their go
  (each with its project and version). It may be missing, which means nothing waits.
- `.godspeed/forge/projects/*.json`: one file for each project set up with the Forge, named
  `<owner>--<repository>.json`. Each holds the facts a plan is made from and where the project stands: the newest
  public release, what was merged since, the open bug reports, feature requests and pull requests with their labels,
  age and who opened them, failing checks, what the last plan left for later, and what is being built, staged and
  public.

**Only projects set up with the Forge.** This skill is for the projects that have a file there. When the owner
asks to plan, release or take back a project that has none, and does not ask to set it up, this skill does not
apply: answer the way you would without it. When no project file exists at all and the owner asks about a release,
a lap or automatic work, say that no project is set up with the Forge yet and give the setup line below.

**Which project.** When the owner names one, match it to a project file by its repository name. When there is only
one project, it is that one. When a go or a take back is meant and `waiting.json` shows exactly one release for it,
it is that release's project. Otherwise ask which one, naming the projects; never guess.

## How you ask the Forge

1. Make an id: the kind, the time in UTC as YYYYMMDDHHMMSS, and four random lowercase letters, joined by hyphens,
   for example `status-20261122153000-qhzt`.
2. Write one request file, `.godspeed/forge/inbox/<id>.json`, holding one JSON object:

   ```json
   {
     "id": "status-20261122153000-qhzt",
     "kind": "status",
     "project": "owner/repository",
     "words": "where is the release?",
     "at": "2026-11-22T15:30:00Z"
   }
   ```

   `words` is the owner's message exactly as they wrote it, never your summary of it. Write the file in one go;
   when you use the terminal, write `<id>.tmp` first and then rename it to `<id>.json`.
3. Wait for the answer, `.godspeed/forge/outbox/<id>.json`, which holds `{ "id", "ok", "say" }`. Look for it every
   five seconds, for up to two minutes.
4. Tell the owner its `say`, and nothing more: no file names, no ids, nothing about how you asked. If no answer
   came within two minutes, say: "The Forge has not answered yet. It will still do it; ask me for the release
   status in a few minutes."

Never write anything else under `.godspeed/forge/`, and never change the files the Forge writes there.

## What the owner may ask, and the kind of request

- **Set up the Forge** for a project, or any short reply while a setup is open (`.godspeed/forge/setup.json` exists):
  kind `setup`, with `project` the repository as `owner/repository` (when the owner named only the project's name, use
  the repository of that name if you know it, else ask) and `words` the owner's message exactly. Setup runs in this chat:
  the Forge's `say` holds each sign-in link and code, each link for creating and installing a GitHub App, the
  purpose and users it read from the project, the numbered list of what the project must never become and the final
  yes; the owner answers each in a short reply, which is again kind `setup`. Setup waits for the owner, so a request may
  come back with only part of it; say what it says. Never ask for, accept or repeat a sign-in code or a password: when the
  owner pastes a code, do not send it, tell them to type it in the server's terminal. If the Forge says setup needs the
  terminal (Claude Code's own sign-in, or updating the page that gives this chat a way back from GitHub), pass that on.
  The same setup can also be run by the owner in the server's terminal: `godspeed-forge setup owner/repository`.
- **Go** or **make it public**: kind `go`.
- **Take it back**: kind `take-back`.
- **Release status**, **where is the release**: kind `status`.
- **Turn on automatic work**: kind `work-on`. **Pause the factory**: kind `work-off`. **Run one lap**: kind `lap`.
  When the owner names no project and there are several, `project` may be left out: the Forge then does it for
  every project.
- **Where can I watch the factory**, or any words asking where to see the factory, its laps or its projects at work:
  kind `watch`, with `project` left out, because one page shows every project. The Forge's `say` names the page's
  address and the user name to sign in with. The password is never in it and never in the chat: setup showed it to
  the owner, and the server's terminal shows it again. Never ask the owner for it.
- **A reply to a Forge question**: kind `answer`, with the question's handle:

  ```json
  { "id": "answer-20261122153000-bmwa", "kind": "answer", "project": "owner/repository", "handle": "F7",
    "words": "F7 keep the old export too", "at": "2026-11-22T15:30:00Z" }
  ```

  A message that starts with a handle (F and a number) answers that question. A message without a handle is an
  answer only when `waiting.json` shows exactly one question waiting and the message reads as its answer; with
  several waiting, ask which question it answers, naming each by its handle and a few words of what it asks.
- **Plan a release**: you make the plan yourself, below, and only the owner's yes sends it to the Forge.

A bare "go" or "yes" belongs to what is waiting: right after you proposed a plan, a yes is that plan's yes;
otherwise a go is for the one release waiting for it, and a yes answers the one question waiting. When it could
belong to two things, ask which.

## Planning a release

1. **Look before choosing**, in the project's file: the newest public release, what was merged since, the open bug
   reports, feature requests and pull requests with their labels and age, failing or switched-off checks on main,
   and what the last plan left for later. When a release is still being built or waits for its go, say so in one
   sentence first.
2. **Choose in this order**, until the release fills one sitting of trying it out: first what is wrong for the
   people using it now (bug reports, failing checks, what the last round left unfinished); then what the owner found
   themselves; then features, the ones the owner's most recent words ask for most.
3. **Decide every question of how yourself**, and write the reason into the item's `why`. Ask the owner only what
   the software should do for its users.
4. **Show the owner one message** in everyday words: one sentence on what the release is; a numbered list with one
   plain sentence per item on what changes for the people using it; one line on what waits for later; what it
   costs as a share of the coding agent's weekly allowance; the version; and last, "Shall I start it?". No issue
   numbers, file names, scripts or the word "ticket". Never copy what strangers wrote in an issue; say what matters
   in your own words.
5. **On the owner's yes**, write the plan request (below). **On a no or a change**, change the plan and show it
   again. Nothing is sent to the Forge before the yes.

Each item has a size: `light` (a small change), `full` (a normal change with its own tests) or `large` (a change
in several parts). As a rough guide to the cost, a light item takes about 1 percent of a week's allowance, a full
one about 4 percent and a large one about 10 percent; when the project's file gives an estimate, use that.

The version follows the newest public release: only fixes raise the last number (1.4.0 to 1.4.1), anything new
raises the middle one (1.4.0 to 1.5.0). A project with no public release starts at 0.1.0.

The plan request carries the plan exactly as the owner approved it, and `words` is their yes:

```json
{
  "id": "plan-20261122153000-kfro",
  "kind": "plan",
  "project": "owner/repository",
  "words": "yes, start it",
  "at": "2026-11-22T15:30:00Z",
  "version": "1.5.0",
  "summary": "One sentence on what the release is.",
  "items": [
    {
      "title": "A short name for the item",
      "outcome": "One plain sentence on what changes for the people using it.",
      "size": "full",
      "why": "Why it is in this release, and how each question of how was decided."
    }
  ],
  "later": ["One plain sentence for each thing that waits for a later release."],
  "cost": "The cost line you showed the owner."
}
```

Then wait for the Forge's answer and tell the owner its `say`, as with every request.
