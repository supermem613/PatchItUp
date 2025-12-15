# PatchItUp - Quick Package and Install Script
# Run this after making changes to quickly reinstall the extension

Write-Host "Building PatchItUp Extension..." -ForegroundColor Cyan

# Compile TypeScript
Write-Host "`nCompiling TypeScript..." -ForegroundColor Yellow
npm run compile

if ($LASTEXITCODE -ne 0) {
    Write-Host "Compilation failed!" -ForegroundColor Red
    exit 1
}

# Check if vsce is installed
if (-not (Get-Command vsce -ErrorAction SilentlyContinue)) {
    Write-Host "`nVSCE not found. Installing @vscode/vsce globally..." -ForegroundColor Yellow
    npm install -g @vscode/vsce
}

# Package the extension
Write-Host "`nPackaging extension..." -ForegroundColor Yellow
vsce package --no-yarn

if ($LASTEXITCODE -ne 0) {
    Write-Host "Packaging failed!" -ForegroundColor Red
    exit 1
}

# Find the generated VSIX file
$vsixFile = Get-ChildItem -Path . -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($vsixFile) {
    Write-Host "`nExtension packaged successfully: $($vsixFile.Name)" -ForegroundColor Green
    Write-Host "`nTo install:" -ForegroundColor Cyan
    Write-Host "1. Open VS Code" -ForegroundColor White
    Write-Host "2. Press Ctrl+Shift+X (Extensions)" -ForegroundColor White
    Write-Host "3. Click '...' menu -> 'Install from VSIX...'" -ForegroundColor White
    Write-Host "4. Select: $($vsixFile.FullName)" -ForegroundColor White
    Write-Host "`nOr run: code --install-extension $($vsixFile.Name)" -ForegroundColor Yellow
    
    # Ask if user wants to install now
    Write-Host "`nInstall extension now? (y/n): " -ForegroundColor Cyan -NoNewline
    $response = Read-Host
    
    if ($response -eq "y" -or $response -eq "Y") {
        Write-Host "`nInstalling extension..." -ForegroundColor Yellow
        code --install-extension $vsixFile.FullName
        Write-Host "Done! Reload VS Code to activate." -ForegroundColor Green
    }
} else {
    Write-Host "No VSIX file found!" -ForegroundColor Red
    exit 1
}
