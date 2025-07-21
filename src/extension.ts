import * as vscode from "vscode";

enum Mode {
  Normal = "NORMAL",
  Insert = "INSERT",
  Highlight = "HIGHLIGHT",
  Default = "DEFAULT"
}


type ModifierKey = "j" | "k" | "l" | ";";
type NibbleBit = "p" | "o" | "i" | "u";

const movementKeys = new Set(["w", "a", "s", "d"]);

const nibbleBitPositions: Record<NibbleBit, number> = {
  p: 0,
  o: 1,
  i: 2,
  u: 3,
};
const movementNibbleBitPositions: Record<ModifierKey, number> = {
  j: 0,
  k: 1,
  l: 2,
  ";": 3,
};

const latexSnippetsByNibble: Record<number, vscode.SnippetString> = {
  0b0000: new vscode.SnippetString("\\frac{$1}{$2}"),
  0b0001: new vscode.SnippetString("\\sqrt{$1}"),
  0b0010: new vscode.SnippetString("\\begin{enumerate}\n\t\\item $1\n\\end{enumerate}"),
  // Add more latex snippets if you want
};

const cppSnippetsByNibble: Record<number, vscode.SnippetString> = {
  0b0000: new vscode.SnippetString("if (${1:condition}) {\n\t$0\n}"),
  0b0001: new vscode.SnippetString("while (${1:condition}) {\n\t$0\n}"),
  0b0010: new vscode.SnippetString("for (int i = 0; i < ${1:count}; i++) {\n\t$0\n}"),
  0b0011: new vscode.SnippetString("for (auto& item : ${1:container}) {\n\t$0\n}"),
  0b0100: new vscode.SnippetString(
    "switch (${1:variable}) {\n\tcase ${2:case}:\n\t\t$0\n\t\tbreak;\n}"
  ),
};

const rustSnippetsByNibble: Record<number, vscode.SnippetString> = {
  0b0000: new vscode.SnippetString("fn main() {\n\t$0\n}"),
  0b0001: new vscode.SnippetString("let mut ${1:var} = ${2:value};"),
  0b0010: new vscode.SnippetString("for ${1:item} in ${2:collection}.iter() {\n\t$0\n}"),
  0b0011: new vscode.SnippetString("if ${1:condition} {\n\t$0\n} else {\n\t\n}"),
  0b0100: new vscode.SnippetString("match ${1:expression} {\n\t${2:pattern} => $0,\n\t_ => (),\n}"),
};

let currentSnippetKey: "1" | "2" | "3" = "2";
let currentMode: Mode = Mode.Normal;
let nibbleState: number = 0;
let movementNibble: number = 0;
let pendingModifier: ModifierKey | null = null;
let modePanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  function updateStatus() {
    const modeText = currentMode === Mode.Highlight ? "HIGHLIGHT MODE" : currentMode;
    statusBarItem.text = `-- ${modeText} -- [Snippet: ${nibbleState
      .toString(2)
      .padStart(4, "0")}] [Move: ${movementNibble.toString(2).padStart(4, "0")}]`;
    statusBarItem.show();
  }

  async function updateCursorStyle(editor: vscode.TextEditor | undefined, mode: Mode) {
    if (!editor) return;
    
    if (mode === Mode.Normal || mode === Mode.Insert || mode === Mode.Highlight) {
      editor.options = { ...editor.options, cursorStyle: vscode.TextEditorCursorStyle.Block };
    } else if (mode === Mode.Default) {
      editor.options = { ...editor.options, cursorStyle: vscode.TextEditorCursorStyle.Line };
    }

    let color: string | undefined;
    switch (mode) {
      case Mode.Normal:
        color = "#00b4d8"; // light blue
        break;
      case Mode.Insert:
        color = "#70e000"; // light green
        break;
      case Mode.Highlight:
        color = "#ffc300"; // gold/yellow
        break;
      case Mode.Default:
        color = undefined; // reset to default
        break;
    }

    const config = vscode.workspace.getConfiguration();
    if (color) {
      await config.update(
        "workbench.colorCustomizations",
        { "editorCursor.foreground": color },
        vscode.ConfigurationTarget.Global
      );
    } else {
      const existing = config.get<any>("workbench.colorCustomizations") || {};
      if (existing["editorCursor.foreground"]) {
        delete existing["editorCursor.foreground"];
        await config.update(
          "workbench.colorCustomizations",
          Object.keys(existing).length ? existing : undefined,
          vscode.ConfigurationTarget.Global
        );
      }
    }
  }


function snippetToDescription(key: "1" | "2" | "3", nibble: number) {
  const descriptions: Record<"1" | "2" | "3", Record<number, string>> = {
    "1": {
      0b0000: "frac{}{}",
      0b0001: "sqrt{}",
      0b0010: "Enumerate environment",
    },
    "2": {
      0b0000: "If statement",
      0b0001: "While loop",
      0b0010: "For loop",
      0b0011: "Range-based for",
      0b0100: "Switch statement",
    },
    "3": {
      0b0000: "function boilerplate",
      0b0001: "Mutable variable",
      0b0010: "For-in iterator",
      0b0011: "If-else block",
      0b0100: "Match statement",
    },
  };

  return descriptions[key]?.[nibble] ?? "No description";
}

function buildHintTable(nibble: number) {
  const snippetSets = {
    "1": { name: "LaTeX", map: latexSnippetsByNibble },
    "2": { name: "C++", map: cppSnippetsByNibble },
    "3": { name: "Rust", map: rustSnippetsByNibble },
  };

  let rows = "";

  for (const key of ["1", "2", "3"] as const) {
    const snippetMap = snippetSets[key].map;
    const langName = snippetSets[key].name;
    const snippet = snippetMap[nibble];

    if (snippet) {
      let desc = snippetToDescription(key, nibble);
      rows += `<tr>
        <td style="text-align:center;">${key}</td>
        <td>${langName}</td>
        <td>${desc}</td>
      </tr>`;
    }
  }

  if (!rows) {
    rows = `<tr><td colspan="3" style="text-align:center;">No snippets defined for this nibble</td></tr>`;
  }

  return `<table border="1" cellpadding="4" style="border-collapse: collapse; color: #ccc; width: 100%;">
    <thead style="background-color: #333;">
      <tr>
        <th>Keybind</th>
        <th>Language</th>
        <th>Snippet Description</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`;
}

function sendUpdateToPanel() {
  if (!modePanel) return;
  const hintHtml = buildHintTable(nibbleState);
  const movementMultiplier = getMovementMultiplier();
  modePanel.webview.postMessage({
    type: "update",
    mode: currentMode,
    nibble: nibbleState,
    movementNibble: movementNibble,
    movementMultiplier,
    hintHtml,
  });
}



  function setMode(mode: Mode) {
    currentMode = mode;
    if (mode !== Mode.Highlight) pendingModifier = null;
    vscode.commands.executeCommand("setContext", "ryvimMode", mode.toLowerCase());
    updateStatus();
    updateCursorStyle(vscode.window.activeTextEditor, mode);
    sendUpdateToPanel();
  }

  async function toggleSnippetNibbleBit(key: NibbleBit) {
    nibbleState ^= 1 << nibbleBitPositions[key];
    updateStatus();
    sendUpdateToPanel();
  }

  async function toggleMovementNibbleBit(key: ModifierKey) {
    movementNibble ^= 1 << movementNibbleBitPositions[key];
    updateStatus();
    sendUpdateToPanel();
  }

  function getMovementMultiplier(): number {
    if (movementNibble === 0) return 1;
    let multiplier = 1;
    for (let bit = 0; bit < 4; bit++) {
      if ((movementNibble & (1 << bit)) !== 0) {
        multiplier *= Math.pow(2, bit + 1);
      }
    }
    return multiplier;
  }

  const toInsert = vscode.commands.registerCommand("ryvim.toInsert", () => {
    setMode(Mode.Insert);
  });

  const toNormal = vscode.commands.registerCommand("ryvim.toNormal", () => {
    setMode(Mode.Normal);
  });

  const toHighlight = vscode.commands.registerCommand("ryvim.toHighlight", () => {
    setMode(Mode.Highlight);
  });

  const toDefault = vscode.commands.registerCommand("ryvim.toDefault", () => {
    setMode(Mode.Default);
  });


type KeyWithModifiers = {
  key: string;
  altKey?: boolean;
} | string;

const handleNormalKey = vscode.commands.registerCommand(
  "ryvim.handleNormalKey",
  async (payload: KeyWithModifiers) => {
    const key = typeof payload === "string" ? payload : payload.key;
    const altKey = typeof payload === "object" && "altKey" in payload ? payload.altKey ?? false : false;


    if (currentMode !== Mode.Normal && currentMode !== Mode.Highlight) {
      if (currentMode === Mode.Default) return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const select = currentMode === Mode.Highlight;

    async function moveCursorCommand(
      direction: "Left" | "Right" | "Up" | "Down",
      count: number,
      select: boolean
    ) {
      const commandBase = "cursor" + direction + (select ? "Select" : "");
      for (let i = 0; i < count; i++) {
        await vscode.commands.executeCommand(commandBase);
      }
    }

    if (["p", "o", "i", "u"].includes(key)) {
      await toggleSnippetNibbleBit(key as NibbleBit);
      return;
    }

    if (["j", "k", "l", ";"].includes(key)) {
      await toggleMovementNibbleBit(key as ModifierKey);
      return;
    }

    if (movementKeys.has(key)) {
      const multiplier = getMovementMultiplier();
      switch (key) {
        case "w":
          await moveCursorCommand("Up", multiplier, select);
          break;
        case "a":
          await moveCursorCommand("Left", multiplier, select);
          break;
        case "s":
          await moveCursorCommand("Down", multiplier, select);
          break;
        case "d":
          await moveCursorCommand("Right", multiplier, select);
          break;
      }
      pendingModifier = null;
      return;
    }

    switch (key) {
      case "w":
        await moveCursorCommand("Up", 1, select);
        break;
      case "a":
        await moveCursorCommand("Left", 1, select);
        break;
      case "s":
        await moveCursorCommand("Down", 1, select);
        break;
      case "d":
        await moveCursorCommand("Right", 1, select);
        break;

      case "e":
        if (currentMode === Mode.Highlight) setMode(Mode.Normal);
        else setMode(Mode.Highlight);
        break;

case "c": {
  if (currentMode === Mode.Normal) {
    const line = editor.document.lineAt(editor.selection.active.line);
    const lineRange = line.range;

    editor.selection = new vscode.Selection(lineRange.start, lineRange.end);

    await vscode.commands.executeCommand("editor.action.clipboardCopyAction");

    editor.selection = new vscode.Selection(lineRange.start, lineRange.start);
  } else if (currentMode === Mode.Highlight) {
    if (!editor.selection.isEmpty) {
      await vscode.commands.executeCommand("editor.action.clipboardCopyAction");
    }
  }
  break;
}

      case "v":
        await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
        break;

case "x": {
  if (currentMode === Mode.Normal) {
    const line = editor.document.lineAt(editor.selection.active.line);
    const lineRange = line.rangeIncludingLineBreak;

    editor.selection = new vscode.Selection(lineRange.start, lineRange.end);

    await vscode.commands.executeCommand("editor.action.clipboardCutAction");

  } else if (currentMode === Mode.Highlight) {
    if (!editor.selection.isEmpty) {
      await vscode.commands.executeCommand("editor.action.clipboardCutAction");
    }
  }
  break;
}

      case "z":
        await vscode.commands.executeCommand("undo");
        break;

      case "b":
        await vscode.commands.executeCommand("redo");
        break;

      case "f": {
        const line = document.lineAt(editor.selection.active.line);
        const newPos = line.range.end;
        editor.selection = new vscode.Selection(newPos, newPos);
        setMode(Mode.Insert);
        break;
      }

      case "F": {
        const line = document.lineAt(editor.selection.active.line);
        const newPos = line.range.start;
        editor.selection = new vscode.Selection(newPos, newPos);
        setMode(Mode.Insert);
        break;
      }

      case "1": {
        currentSnippetKey = "1";
        const snippet = latexSnippetsByNibble[nibbleState];
        if (snippet) {
          await editor.insertSnippet(snippet, editor.selection.active);
          if (altKey) setMode(Mode.Insert);
        } else {
          vscode.window.showWarningMessage(
            `No LaTeX snippet defined for nibble ${nibbleState
              .toString(2)
              .padStart(4, "0")}`
          );
        }
        break;
      }

      case "2": {
        currentSnippetKey = "2";
        const snippet = cppSnippetsByNibble[nibbleState];
        if (snippet) {
          await editor.insertSnippet(snippet, editor.selection.active);
          if (altKey) setMode(Mode.Insert);
        } else {
          vscode.window.showWarningMessage(
            `No C++ snippet defined for nibble ${nibbleState
              .toString(2)
              .padStart(4, "0")}`
          );
        }
        break;
      }

      case "3": {
        currentSnippetKey = "3";
        const snippet = rustSnippetsByNibble[nibbleState];
        if (snippet) {
          await editor.insertSnippet(snippet, editor.selection.active);
          if (altKey) setMode(Mode.Insert);
        } else {
          vscode.window.showWarningMessage(
            `No Rust snippet defined for nibble ${nibbleState
              .toString(2)
              .padStart(4, "0")}`
          );
        }
        break;
      }

      default:
        break;
    }

    pendingModifier = null;
  }
);



  function createModePanel(context: vscode.ExtensionContext) {
    if (modePanel) {
      modePanel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    modePanel = vscode.window.createWebviewPanel(
      "ryvimModePanel",
      "RyVim Mode Info",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    modePanel.webview.html = getWebviewContent();

    modePanel.onDidDispose(() => {
      modePanel = undefined;
    });

    sendUpdateToPanel();
  }

  function getWebviewContent(): string {
    return `
      <!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>RyVim Mode</title>
  <style>
    body {
      font-family: sans-serif;
      padding: 10px;
      background-color: #1e1e1e;
      color: #ccc;
    }
    #mode {
      font-size: 40px;
      font-weight: bold;
      border-radius: 5px;
      display: inline-block;
      min-width: 100px;
      text-align: center;
      user-select: none;
    }
    #mode.normal {
      color: #00b4d8; /* light blue */
    }
    #mode.insert {
      color: #70e000; /* light green */
    }
    #mode.highlight {
      color: #ffc300; /* gold/yellow */
    }
    #mode.default {
      color: #ffffff;
    }
    .nibble-bar, .movement-bar {
      margin-top: 20px;
      display: flex;
      gap: 6px;
      width: 160px;
    }
    .bit-box {
      flex: 1;
      height: 30px;
      border-radius: 5px;
      box-shadow: inset 0 0 5px #222;
      user-select: none;
      transition: background-color 0.3s ease;
      display: flex;
      justify-content: center;
      align-items: center;
      color: black;
      font-weight: bold;
      font-size: 14px;
    }
    .bit-box.unset {
      background-color: #444;
    }
    .bit-box.set-snippet {
      background-color: white;
      box-shadow: inset 0 0 10px white;
      color: black;
    }
    .bit-box.set-move-j {
      background-color: #ff9999; /* red */
    }
    .bit-box.set-move-k {
      background-color: #99ff99; /* green */
    }
    .bit-box.set-move-l {
      background-color: #9999ff; /* blue */
    }
    .bit-box.set-move-semi {
      background-color: #ffcc66; /* orange */
    }
    #hintText {
      margin-top: 20px;
      user-select: none;
      color: #ccc;
      font-family: monospace;
      font-size: 14px;
      white-space: pre-wrap;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      color: #ccc;
    }
    th, td {
      border: 1px solid #666;
      padding: 6px 8px;
      text-align: left;
    }
    thead {
      background-color: #333;
    }
    tbody tr.active {
      font-weight: bold;
      background-color: #444;
    }
  </style>
</head>
<body>
  <div id="mode" class="normal">NORMAL</div>

  <div><strong>Movement Bits</strong> <span id="movementMultiplier" style="margin-left: 10px; font-weight: bold; color: #ccc;">×1</span></div>
  <div class="movement-bar">
    <div id="moveBit0" class="bit-box unset">J</div>
    <div id="moveBit1" class="bit-box unset">K</div>
    <div id="moveBit2" class="bit-box unset">L</div>
    <div id="moveBit3" class="bit-box unset">;</div>
  </div>
<br> 
  <div><strong>Snippet Bits</strong></div>
  <div class="nibble-bar">
    <div id="bit3" class="bit-box unset">U</div>
    <div id="bit2" class="bit-box unset">I</div>
    <div id="bit1" class="bit-box unset">O</div>
    <div id="bit0" class="bit-box unset">P</div>
  </div>

  <div id="hintText">Waiting for updates...</div>

  <script>
    const vscode = acquireVsCodeApi();
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'update') {
        const modeEl = document.getElementById('mode');
        modeEl.textContent = message.mode;

        modeEl.classList.remove('normal', 'insert', 'highlight');
        switch(message.mode.toLowerCase()) {
          case 'normal': modeEl.classList.add('normal'); break;
          case 'insert': modeEl.classList.add('insert'); break;
          case 'highlight': modeEl.classList.add('highlight'); break;
        }

        for (let i=0; i<4; i++) {
          const bitBox = document.getElementById('bit'+i);
          if ((message.nibble & (1 << i)) !== 0) {
            bitBox.className = 'bit-box set-snippet';
          } else {
            bitBox.className = 'bit-box unset';
          }
        }

        const moveClasses = ['set-move-j','set-move-k','set-move-l','set-move-semi'];
        const multiplierEl = document.getElementById('movementMultiplier');
        multiplierEl.textContent = "×" + (message.movementMultiplier || 1);

        for(let i=0; i<4; i++) {
          const bitBox = document.getElementById('moveBit'+i);
          if ((message.movementNibble & (1 << i)) !== 0) {
            bitBox.className = 'bit-box ' + moveClasses[i];
          } else {
            bitBox.className = 'bit-box unset';
          }
        }

        document.getElementById('hintText').innerHTML = message.hintHtml || "No hints available.";
      }
    });
  </script>
</body>
</html>

    `;
  }

  context.subscriptions.push(toInsert, toNormal, toHighlight, handleNormalKey, toDefault);

  vscode.window.onDidChangeActiveTextEditor((editor) => {
    updateCursorStyle(editor, currentMode);
  });

  createModePanel(context);

  setMode(currentMode);
  updateStatus();
}

export function deactivate() {
  const config = vscode.workspace.getConfiguration();
  config.update("workbench.colorCustomizations", undefined, vscode.ConfigurationTarget.Global);
}

