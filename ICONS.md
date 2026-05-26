# Custom Icons for vscode-icons

This extension ships with custom icon SVGs for use with the [vscode-icons](https://github.com/vscode-icons/vscode-icons) extension. When both extensions are installed, `.ree` files and `ree-templates` folders display the branded red "R" icon.

## Folder Location

The custom icons live in a `vsicons-custom-icons` folder inside the VS Code user data directory:

**Windows:**
```
%APPDATA%\Code\User\vsicons-custom-icons
```

**Linux:**
```
~/.config/Code/User/vsicons-custom-icons
```

**macOS:**
```
~/Library/Application Support/Code/User/vsicons-custom-icons
```

The folder name **must** be `vsicons-custom-icons` exactly. Replace `Code` with `Code - Insiders`, `Code - OSS`, or `code-oss-dev` depending on your VS Code variant.

## Naming Conventions

vscode-icons resolves custom icons by filename. The naming format is:

| Type     | Format                                                |
| -------- | ----------------------------------------------------- |
| File     | `file_type_<icon_name>.svg`                           |
| Folder   | `folder_type_<icon_name>.svg` (closed)                |
| Folder   | `folder_type_<icon_name>_opened.svg` (open)           |
| Default  | `default_<icon_name>.svg` (default file/folder icon)  |

For this extension, the icon name is `ree`, producing:

| File                                  | Purpose              |
| ------------------------------------- | -------------------- |
| `file_type_ree.svg`                   | `.ree` file icon     |
| `folder_type_ree.svg`                 | Folder icon (closed) |
| `folder_type_ree_opened.svg`          | Folder icon (open)   |

## Setup Steps

### 1. Create the icons folder

```bash
mkdir -p "$APPDATA/Code/User/vsicons-custom-icons"
```

> On Windows in PowerShell, use:  
> `mkdir "$env:APPDATA\Code\User\vsicons-custom-icons"`

### 2. Copy the SVG icons

Copy the extension's existing icon into all three required files:

```bash
# From the extension project root
cp icons/ree-file.svg "$APPDATA/Code/User/vsicons-custom-icons/file_type_ree.svg"
cp icons/ree-file.svg "$APPDATA/Code/User/vsicons-custom-icons/folder_type_ree.svg"
cp icons/ree-file.svg "$APPDATA/Code/User/vsicons-custom-icons/folder_type_ree_opened.svg"
```

All three currently use the same design (red circle with white "R"). If you want distinct folder icons (e.g., folder-shaped SVGs), replace `folder_type_ree.svg` and `folder_type_ree_opened.svg` with custom designs.

### 3. Configure VS Code settings

Add the following to your VS Code `settings.json`:

```json
"vsicons.associations.files": [
    { "icon": "ree", "extensions": ["ree"], "format": "svg" }
],
"vsicons.associations.folders": [
    { "icon": "ree", "extensions": ["ree-templates"], "format": "svg" }
]
```

### 4. Apply the customization

1. Open VS Code
2. Press `F1` to open the Command Palette
3. Run **"Icons: Apply Icons Customization"**
4. VS Code will reload and apply the custom icons

## How It Works

vscode-icons looks for a `vsicons-custom-icons` folder in the user data directory. Any SVGs placed there following the naming convention become available as custom icon targets. The `vsicons.associations.files` and `vsicons.associations.folders` settings map file extensions and folder names to those icons.

The "Apply Icons Customization" command regenerates vscode-icons' internal manifest, picking up any new or changed SVGs and associations.

## Troubleshooting

**Icons not showing after setup:**
- Verify the folder is named exactly `vsicons-custom-icons`
- Verify filenames match the convention (`file_type_ree.svg`, etc.)
- Run **"Icons: Apply Icons Customization"** from the Command Palette
- Check that `workbench.iconTheme` is set to `"vscode-icons"` in settings.json

**Wrong icon showing:**
- Check for conflicts with other vscode-icons associations
- The `overrides` option can replace an existing icon definition

**Settings not saving:**
- Ensure `settings.json` is valid JSON (no trailing commas)
- Reload the VS Code window after editing

## References

- [vscode-icons Wiki: Custom Icons](https://github.com/vscode-icons/vscode-icons/wiki/Custom)
- [vscode-icons Wiki: Configuration](https://github.com/vscode-icons/vscode-icons/wiki/Configuration)
- [vscode-icons Wiki: Fine Tuning](https://github.com/vscode-icons/vscode-icons/wiki/FineTuning)
