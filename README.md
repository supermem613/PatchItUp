# PatchItUp

**Seamlessly transfer code changes between GitHub Codespaces and your local machine using git patches.**

PatchItUp is a VS Code extension that makes it easy to create git patches from your work in GitHub Codespaces and save them directly to your local machine. You can also apply saved patches back to your Codespace - perfect for backing up work-in-progress or transferring changes between environments.

## ✨ Features

- **📦 Create Patches** - Generate git patches from uncommitted changes in your Codespace
- **💾 Save to Local Machine** - Patches are saved directly to your host machine, not the Codespace
- **📋 Apply Patches** - Select and apply any saved patch back to your Codespace
- **🎯 Sidebar UI** - Intuitive panel in the activity bar for easy access
- **🔄 Automatic Refresh** - Patch list updates automatically after creating new patches
- **⏰ Timestamp Names** - Patches named with project and timestamp: `projectname_YYYYMMDDHHMMSS.patch`
- **📁 Browse Patches** - See all your patches in a sortable list (newest first)
- **⚙️ Configurable** - Set source directory, project name, and destination path

## 🖼️ Screenshots

![PatchItUp Sidebar](images/sidebar.png)
*The PatchItUp panel showing configuration fields and available patches, allowing for creating and applying patches.*

## 🚀 Quick Start

1. **Install the extension** in VS Code
2. **Open the PatchItUp panel** - Click the diff icon in the activity bar (left sidebar)
3. **Configure settings:**
   - **Source Directory**: `/workspaces/your-project` (your Codespace workspace path)
   - **Project Name**: `my-project` (used in patch filenames)
   - **Destination Path**: `C:\Users\YourName\patches` (local path on your machine)
4. **Make changes** in your Codespace
5. **Click "Create Patch"** - Patch is saved to your local machine
6. **Apply patches** - Select a patch from the list and click "Apply Selected Patch"

## 📖 Usage

### Creating Patches

1. Make changes to files in your Codespace (don't commit them)
2. Open the PatchItUp panel from the activity bar
3. Click **Create Patch**
4. The patch is saved to your local destination path with format: `projectname_YYYYMMDDHHMMSS.patch`

### Applying Patches

1. Open the PatchItUp panel
2. Select a patch from the **Available Patches** list
3. Click **Apply Selected Patch**
4. The patch is applied to your Codespace working directory

### Command Palette

You can also use the command palette (Ctrl+Shift+P):
- `PatchItUp: Create and Save Patch`
- `PatchItUp: Open Panel`

## ⚙️ Configuration

Configure the extension in VS Code settings (File > Preferences > Settings):

### `patchitup.sourceDirectory`
- **Description**: Directory in Codespace to create patches from
- **Default**: `/tmp`
- **Example**: `/workspaces/odsp-next`

### `patchitup.projectName`
- **Description**: Project name prefix for patch files
- **Default**: `project`
- **Example**: `my-app`

### `patchitup.destinationPath`
- **Description**: Local path on host machine to save patches
- **Default**: `` (empty - must be configured)
- **Windows Example**: `C:\Users\YourName\patches`
- **Mac/Linux Example**: `/Users/YourName/patches`

## 🔧 Requirements

- VS Code 1.85.0 or higher
- Git installed in your Codespace
- Write access to the destination path on your local machine

## 🎯 Use Cases

- **Backup WIP**: Save work-in-progress before closing your Codespace
- **Transfer Changes**: Move changes between Codespaces or to local development
- **Code Review**: Create patches for reviewing changes outside the Codespace
- **Experimentation**: Try changes and easily revert by applying a previous patch
- **Collaboration**: Share patches with team members

## 🛠️ How It Works

1. **Remote Detection**: Automatically detects when running in a Codespace
2. **Git Diff**: Uses `git diff HEAD` to capture all uncommitted changes
3. **Remote File API**: Uses VS Code's `vscode-local` URI scheme to write directly to your host machine
4. **Patch Application**: Copies patch from local machine to Codespace and applies with `git apply`
5. **Clean Up**: Temporary files are automatically removed after applying patches

## 📝 Patch File Format

Patch files use the standard git patch format and are named:
```
{projectName}_{YYYYMMDDHHMMSS}.patch
```

Example: `odsp-next_20251126143052.patch`
- `odsp-next`: Project name
- `20251126`: Date (November 26, 2025)
- `143052`: Time (14:30:52)
- `.patch`: Extension

## 🐛 Troubleshooting

### "Source directory does not exist"
- Click "Use Current Workspace" to automatically set the directory
- Or manually configure `patchitup.sourceDirectory` in settings

### "Please configure the destination path"
- Set `patchitup.destinationPath` to a valid local path on your machine
- Make sure the path exists or the extension will create it

### "No changes to create a patch from"
- Make sure you have uncommitted changes in your Codespace
- Changes must be staged or modified (untracked files need to be added first)

### Patches not appearing in list
- Check that the destination path is correct
- Reload the panel or refresh by changing the destination path

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## 📬 Feedback

Have suggestions or found a bug? Please [open an issue](https://github.com/supermem613/PatchItUp/issues) on GitHub.

