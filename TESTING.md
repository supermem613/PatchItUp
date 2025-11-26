# Testing PatchItUp in GitHub Codespaces

## The Problem

When using F5 debugging, the Extension Development Host only runs temporarily and won't persist when you open a Codespace or reload VS Code.

## Solution: Install the Extension

### Method 1: Package and Install (Recommended)

1. **Install VSCE (VS Code Extension Manager)**
   ```bash
   npm install -g @vscode/vsce
   ```

2. **Package the extension**
   ```bash
   cd c:\Users\foo\repos\PatchItUp
   vsce package
   ```
   This creates a `.vsix` file (e.g., `patchitup-0.0.1.vsix`)

3. **Install in VS Code**
   - Open VS Code
   - Go to Extensions (Ctrl+Shift+X)
   - Click the "..." menu at the top
   - Select "Install from VSIX..."
   - Choose the generated `.vsix` file

4. **Use in Codespaces**
   - Open your GitHub Codespace
   - The extension is now available
   - Configure settings: Ctrl+, → search "PatchItUp"
   - Set destination path to a local folder on your host machine
   - Run command: `PatchItUp: Create and Save Patch`

### Method 2: Local Development with Remote Testing

If you need to test changes frequently:

1. **Keep the watch task running**
   ```bash
   npm run watch
   ```

2. **After each change, repackage**
   ```bash
   vsce package
   ```

3. **Reinstall the VSIX**
   - Uninstall the previous version (Extensions → PatchItUp → Uninstall)
   - Install the new VSIX file

### Method 3: Symlink for Development (Advanced)

1. **Package without minification**
   ```bash
   vsce package --no-yarn
   ```

2. **Link to VS Code extensions folder**
   Windows:
   ```powershell
   $extensionsPath = "$env:USERPROFILE\.vscode\extensions"
   New-Item -ItemType SymbolicLink -Path "$extensionsPath\patchitup" -Target "c:\Users\foo\repos\PatchItUp"
   ```

3. **Reload VS Code** (Ctrl+Shift+P → "Developer: Reload Window")

## Recommended Workflow

1. **Initial setup**: Package and install the extension
2. **Make changes**: Edit code in your local repo
3. **Test changes**: 
   - Run `npm run compile`
   - Run `vsce package`
   - Reinstall VSIX
   - Reload VS Code window
4. **Use in Codespaces**: Extension works in any Codespace you open

## Key Configuration for Codespaces

When testing in a Codespace, make sure to set:

- **Source Directory**: `/tmp` (or your Codespace path)
- **Destination Path**: A path on your **local machine** (e.g., `C:\Users\foo\patches`)
- **Project Name**: Your project identifier

The extension will read files from the Codespace but write the patch to your local machine.
