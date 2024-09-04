Visual Studio Code extension for the OMNeT++ NED and MSG languages.

[Download latest release](https://github.com/omnetpp/omnetpp-vscode/releases/latest) or build locally.

## Features

Syntax highlighting of .ned and .msg files. The extension uses the [NED](https://github.com/omnetpp/omnetpp-textmate-ned) and [MSG](https://github.com/omnetpp/omnetpp-textmate-msg) TextMate grammars.

## Requirements

VS Code version 1.92 or higher.

## Building locally

Node.js is required for building the extension locally (see https://nodejs.org for install instructions). 

- Clone this repo
- Run `refresh_submodules` to fetch the grammar submodules
- Install `vsce`: `npm install -g @vscode/vsce`

To build the .vsix file, run:

`npm run package`

## Installing

In VSCode/Extensions side panel, select 'Install from VSIX...' from the ... menu
