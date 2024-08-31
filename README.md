TextMate grammar and Visual Studio Code extension for the OMNeT++ NED and MSG languages.

## Features

Syntax highlighting of .ned and .msg files.

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

In VSCode/Extensions, select 'Install from VSIX...' from the ... menu
