# PatchItUp

A VS Code extension for creating git patches from GitHub Codespaces and saving them to your local machine.

## Features

- Create git patches from all uncommitted changes in a configured directory
- Automatically save patches to your local machine with timestamps
- Configurable source directory, project name, and destination path

## Configuration

Configure the extension in VS Code settings:

- `patchitup.sourceDirectory`: Directory to create the patch from (default: `/tmp`)
- `patchitup.projectName`: Project name to prefix patch files (default: `project`)
- `patchitup.destinationPath`: Local path on host machine to save patches (e.g., `C:\Users\YourName\patches`)

## Usage

1. Open Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
2. Run command: `PatchItUp: Create and Save Patch`
3. The patch file will be saved to your configured destination path

## Requirements

- VS Code 1.85.0 or higher
- Git installed in your Codespace

## Extension Settings

This extension contributes the following settings:

* `patchitup.sourceDirectory`: Set the source directory for creating patches
* `patchitup.projectName`: Set the project name prefix for patch files
* `patchitup.destinationPath`: Set the local destination path for saving patches
