# PatchItUp Development and Usage Guide

## Overview

PatchItUp is a VS Code extension that creates git patches from changes in GitHub Codespaces and saves them to your local machine.

## How It Works

1. The extension runs the `git diff HEAD` command in the configured source directory
2. Creates a patch file with all uncommitted changes
3. Generates a filename with timestamp: `{projectName}_{YYYYMMDDHHMMSS}.patch`
4. Saves the patch to your configured local destination path

## Configuration Steps

### 1. Set the Source Directory (in Codespace)
- Open VS Code Settings (File > Preferences > Settings or Ctrl+,)
- Search for "PatchItUp"
- Set **Source Directory**: `/tmp` (or your project path)

### 2. Set the Project Name
- Set **Project Name**: e.g., `tmp`, `myproject`, etc.
- This will be used as the prefix for patch files

### 3. Set the Destination Path (on Host Machine)
- Set **Destination Path**: Your local machine path
- Windows example: `C:\Users\YourName\patches`
- Mac/Linux example: `/Users/YourName/patches`

## Usage

### Creating a Patch

1. Make changes to files in your Codespace
2. Open Command Palette (Ctrl+Shift+P or Cmd+Shift+P)
3. Type and select: `PatchItUp: Create and Save Patch`
4. The extension will:
   - Check for changes in the source directory
   - Create a git patch
   - Save it to your local machine with a timestamp

### Example Patch Filename

```
tmp_20251126143052.patch
```
This represents: `{projectName}_{Year}{Month}{Day}{Hour}{Minute}{Second}.patch`

## Development

### Running the Extension in Development Mode

1. Open this project in VS Code
2. Press F5 to launch the Extension Development Host
3. In the new window, open your Codespace or project
4. Test the command: `PatchItUp: Create and Save Patch`

### Building for Distribution

```bash
npm install -g @vscode/vsce
vsce package
```

This creates a `.vsix` file that can be installed in VS Code.

### Installing the Extension Locally

1. Build the extension: `vsce package`
2. In VS Code: View > Extensions
3. Click the "..." menu > Install from VSIX
4. Select the generated `.vsix` file

## Troubleshooting

### "No changes to create a patch from"
- Ensure you have uncommitted changes in the source directory
- Check that the source directory path is correct
- Verify git is initialized in the source directory

### "Please configure the destination path"
- Go to Settings > PatchItUp > Destination Path
- Set a valid path on your local machine
- Ensure the path exists or the extension will create it

### Patch file is empty
- Make sure changes are not committed
- The extension captures differences between your working tree and HEAD
- Stage or modify files, but don't commit them yet

### Permission errors
- Ensure the destination path is writable
- On Windows, avoid system-protected directories
- Try using a path in your user directory

## Features

- ✅ Configurable source directory
- ✅ Configurable project name prefix
- ✅ Configurable local destination path
- ✅ Automatic timestamp generation
- ✅ Progress notifications
- ✅ Quick access to saved patch location
- ✅ Copy path to clipboard
- ✅ Open patch folder directly

## Technical Details

### Git Command Used

```bash
cd "{sourceDirectory}" && git diff HEAD
```

This captures all changes (staged and unstaged) compared to the last commit.

### File System Operations

- Reads git output from Codespace filesystem
- Writes patch file to local machine filesystem
- Creates destination directory if it doesn't exist

## Future Enhancements

Potential features for future versions:
- Support for creating patches from specific commits
- Include untracked files option
- Compress patches as .zip
- Automatic patch application
- History of created patches
