You are finishing the setup of Cole Medin's AI software factory in this repository. Its files are already
installed. Nobody can answer questions during this run, so ask none: read the repository and decide.

Read the repository first: its README and other documents, its code, its tests, its build and package files,
and its CI workflows in .github/workflows. Then do exactly these three things and nothing else.

1. Write the file .forge-out-of-scope.json in the repository root. It holds a JSON array of exactly seven
   strings. Each string is one thing this project must never become: a feature or direction that a reasonable
   person would actually ask for, that sounds plausible and easy, and that would still turn it into a different
   product. Never something merely not done yet. One short sentence each, in plain words a user understands,
   without dashes, for example "A hosted service that other people sign up for and pay to use."

2. Replace harness/END-TO-END.md entirely. Start it with the line "# End-to-end journeys". Then write two to five
   journeys of what the project does TODAY, each under its own "## " heading in a user's words, each with
   numbered steps a real user takes through the project's public surface (its command line, its pages, its API)
   and a last line "**What would make this fail:** " naming what the user must see or get. Describe only
   behaviour that exists in the code now, never what it should do one day. Keep none of the example journeys
   about tasks that the file holds now.

3. Edit harness/harness.config.json. Set "static" to the one command, run from the repository root, that runs
   the project's static checks (lint, type check, format check), and "unit" to the one command that runs its
   unit tests, or "" for either when the project has none. Set "required_checks" to the names of the CI jobs in
   .github/workflows that a change must pass, separated by commas (a job's name: value, or its id when it has
   no name), or to "none" when the repository has no CI workflows. Keep every other key exactly as it is, above
   all "protected_paths".

Change no other file. Do not commit, push or change the repository's history. Do not open anything under
.factory/holdout/.
