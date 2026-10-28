# Knowt Sync

An on-demand macOS tool that adds missing vocabulary from a Google Sheet to a Knowt flashcard set. It matches cards by term, skips existing terms, and never deletes cards or changes their definitions. It reports existing terms whose definitions differ.

## Requirements

- Node.js 20 or newer.
- A Google Sheet accessible to anyone with the link, with terms in column A and definitions in column B, starting on row 1.
- A Knowt account with permission to edit the target flashcard set. The set must be readable through its link.

## Set up

1. If Node.js 20+ is not installed, install it with Homebrew. If Homebrew is also missing, run its install command in Terminal:

   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

   Follow the installer's **Next steps** to add `brew` to your shell's PATH. Then install Node.js:

   ```bash
   brew install node
   ```

2. Copy `config.example.json` to `config.json` in the project folder:

   ```bash
   cp config.example.json config.json
   ```

3. Edit `config.json`:

   - `projectPath`: the absolute path to this project folder (`pwd` prints it).
   - `googleSheetUrl`: the Google Sheet URL, including its `gid` if needed.
   - `knowtSetUrl`: the Knowt flashcard set URL. Its title does not matter.

4. Install dependencies and sign in to Knowt:

   ```bash
   zsh setup.sh
   ```

   Sign in in the browser window. The setup continues automatically after login.

## Use

Double-click `sync.command`, or run `npm run sync` from this folder. Each run syncs once. When new words are found, a saved Knowt session lets the tool add them without showing a browser window. If the session has expired, a browser window opens for login, then the sync continues automatically.

Run `npm run check` to list missing terms without adding them.

`config.json` and `runtime/` stay on your Mac and are ignored by Git. The browser profile in `runtime/` contains your Knowt login session; do not share it. There is no background schedule.
