# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Watch mode** (`--watch`): review changes made by *any* process, such as an agent running in a terminal, while a watch thread is open in Zed. Editor-originated writes (Reject, our own writes, format-on-save) are recognised and not re-reviewed, and files with unsaved editor changes are never touched.
- Changed files are opened in the editor automatically at the first changed line (`--open-with`, default `zeditor`/`zed`; `--no-open` to disable).
- `--interval` option for the watch-mode polling interval.

## [0.1.0] - 2026-11-21

### Added

- ACP agent over stdio (protocol version 1) that wraps any CLI coding agent.
- Snapshot-before / diff-after review: changed text files are routed through the client's `fs/write_text_file`, so Zed shows them as inline Keep / Reject agent edits.
- Created files are reviewable. Deleted files are backed up and reported.
- Built-in ignore list (`node_modules/`, `venv/`, `.git/`, ...) and `.gitignore` support.
- Streaming of agent stdout (message) and stderr (thought) into the agent panel.
- `session/cancel` support: the agent's process group is terminated and partial changes are still reviewed.
- Options: `--next-turn-arg`, `--ignore`, `--max-file-size`, `--output`, `--sync-timeout`, `--backup-dir`, `--no-review`, `--name`, `--verbose`.
