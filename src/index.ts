// Copyright (c) Mehmet Bektas <mbektasgh@outlook.com>

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  JupyterLab
} from '@jupyterlab/application';

import { IDocumentManager } from '@jupyterlab/docmanager';
import { DocumentWidget } from '@jupyterlab/docregistry';

import { Dialog } from '@jupyterlab/apputils';

import { IEditorLanguageRegistry } from '@jupyterlab/codemirror';

import { CodeCell } from '@jupyterlab/cells';
import { ISharedNotebook } from '@jupyter/ydoc';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import {
  CompletionHandler,
  ICompletionProviderManager,
  IInlineCompletionContext,
  IInlineCompletionItem,
  IInlineCompletionList,
  IInlineCompletionProvider
} from '@jupyterlab/completer';

import { NotebookPanel } from '@jupyterlab/notebook';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { FileEditorWidget } from '@jupyterlab/fileeditor';

import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';

import { ContentsManager, KernelSpecManager } from '@jupyterlab/services';

import { LabIcon } from '@jupyterlab/ui-components';

import { Menu, Panel, Widget } from '@lumino/widgets';
import { CommandRegistry } from '@lumino/commands';
import { IStatusBar } from '@jupyterlab/statusbar';

import {
  ChatSidebar,
  GitHubCopilotLoginDialogBody,
  GitHubCopilotStatusBarItem,
  InlinePromptWidget,
  RunChatCompletionType
} from './chat-sidebar';
import { GitHubCopilot, GitHubCopilotLoginStatus } from './github-copilot';
import {
  BackendMessageType,
  IActiveDocumentInfo,
  ICellContents,
  RequestDataType
} from './tokens';
import sparklesSvgstr from '../style/icons/sparkles.svg';
import copilotSvgstr from '../style/icons/copilot.svg';

import {
  applyCodeToSelectionInEditor,
  cellOutputAsText,
  compareSelections,
  extractCodeFromMarkdown,
  getSelectionInEditor,
  getTokenCount,
  getWholeNotebookContent,
  isSelectionEmpty,
  markdownToComment,
  waitForDuration
} from './utils';
import { UUID } from '@lumino/coreutils';

namespace CommandIDs {
  export const chatuserInput = 'notebook-intelligence:chat-user-input';
  export const insertAtCursor = 'notebook-intelligence:insert-at-cursor';
  export const addCodeAsNewCell = 'notebook-intelligence:add-code-as-new-cell';
  export const createNewFile = 'notebook-intelligence:create-new-file';
  export const createNewNotebookFromPython =
    'notebook-intelligence:create-new-notebook-from-py';
  export const addCodeCellToNotebook =
    'notebook-intelligence:add-code-cell-to-notebook';
  export const addMarkdownCellToNotebook =
    'notebook-intelligence:add-markdown-cell-to-notebook';
  export const editorGenerateCode =
    'notebook-intelligence:editor-generate-code';
  export const editorExplainThisCode =
    'notebook-intelligence:editor-explain-this-code';
  export const editorFixThisCode = 'notebook-intelligence:editor-fix-this-code';
  export const editorExplainThisOutput =
    'notebook-intelligence:editor-explain-this-output';
  export const editorTroubleshootThisOutput =
    'notebook-intelligence:editor-troubleshoot-this-output';
  export const openGitHubCopilotLoginDialog =
    'notebook-intelligence:open-github-copilot-login-dialog';
}

const DOCUMENT_WATCH_INTERVAL = 1000;
const MAX_TOKENS = 4096;
const githuCopilotIcon = new LabIcon({
  name: 'notebook-intelligence:github-copilot-icon',
  svgstr: copilotSvgstr
});

const emptyNotebookContent: any = {
  cells: [],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5
};

class ActiveDocumentWatcher {
  static initialize(
    app: JupyterLab,
    languageRegistry: IEditorLanguageRegistry
  ) {
    ActiveDocumentWatcher._languageRegistry = languageRegistry;

    app.shell.currentChanged?.connect((_sender, args) => {
      ActiveDocumentWatcher.watchDocument(args.newValue);
    });

    ActiveDocumentWatcher.activeDocumentInfo.activeWidget =
      app.shell.currentWidget;
    ActiveDocumentWatcher.handleWatchDocument();
  }

  static watchDocument(widget: Widget) {
    if (ActiveDocumentWatcher.activeDocumentInfo.activeWidget === widget) {
      return;
    }
    clearInterval(ActiveDocumentWatcher._watchTimer);
    ActiveDocumentWatcher.activeDocumentInfo.activeWidget = widget;

    ActiveDocumentWatcher._watchTimer = setInterval(() => {
      ActiveDocumentWatcher.handleWatchDocument();
    }, DOCUMENT_WATCH_INTERVAL);

    ActiveDocumentWatcher.handleWatchDocument();
  }

  static handleWatchDocument() {
    const activeDocumentInfo = ActiveDocumentWatcher.activeDocumentInfo;
    const previousDocumentInfo = {
      ...activeDocumentInfo,
      ...{ activeWidget: null }
    };

    const activeWidget = activeDocumentInfo.activeWidget;
    if (activeWidget instanceof NotebookPanel) {
      const np = activeWidget as NotebookPanel;
      activeDocumentInfo.filename = np.sessionContext.name;
      activeDocumentInfo.filePath = np.sessionContext.path;
      activeDocumentInfo.language =
        (np.model?.sharedModel?.metadata?.kernelspec?.language as string) ||
        'python';
      const { activeCellIndex, activeCell } = np.content;
      activeDocumentInfo.activeCellIndex = activeCellIndex;
      activeDocumentInfo.selection = activeCell?.editor?.getSelection();
    } else if (activeWidget) {
      const dw = activeWidget as DocumentWidget;
      const contentsModel = dw.context?.contentsModel;
      if (contentsModel?.format === 'text') {
        const fileName = contentsModel.name;
        const filePath = contentsModel.path;
        const language =
          ActiveDocumentWatcher._languageRegistry.findByMIME(
            contentsModel.mimetype
          ) || ActiveDocumentWatcher._languageRegistry.findByFileName(fileName);
        activeDocumentInfo.language = language?.name || 'unknown';
        activeDocumentInfo.filename = fileName;
        activeDocumentInfo.filePath = filePath;
        if (activeWidget instanceof FileEditorWidget) {
          const fe = activeWidget as FileEditorWidget;
          activeDocumentInfo.selection = fe.content.editor?.getSelection();
        } else {
          activeDocumentInfo.selection = undefined;
        }
      } else {
        activeDocumentInfo.filename = '';
        activeDocumentInfo.filePath = '';
        activeDocumentInfo.language = '';
      }
    }

    if (
      ActiveDocumentWatcher.documentInfoChanged(
        previousDocumentInfo,
        activeDocumentInfo
      )
    ) {
      ActiveDocumentWatcher.fireActiveDocumentChangedEvent();
    }
  }

  private static documentInfoChanged(
    lhs: IActiveDocumentInfo,
    rhs: IActiveDocumentInfo
  ): boolean {
    if (!lhs || !rhs) {
      return true;
    }

    return (
      lhs.filename !== rhs.filename ||
      lhs.filePath !== rhs.filePath ||
      lhs.language !== rhs.language ||
      lhs.activeCellIndex !== rhs.activeCellIndex ||
      !compareSelections(lhs.selection, rhs.selection)
    );
  }

  static getActiveSelectionContent(): string {
    const activeDocumentInfo = ActiveDocumentWatcher.activeDocumentInfo;
    const activeWidget = activeDocumentInfo.activeWidget;

    if (activeWidget instanceof NotebookPanel) {
      const np = activeWidget as NotebookPanel;
      const editor = np.content.activeCell.editor;
      if (isSelectionEmpty(editor.getSelection())) {
        return getWholeNotebookContent(np);
      } else {
        return getSelectionInEditor(editor);
      }
    } else if (activeWidget instanceof FileEditorWidget) {
      const fe = activeWidget as FileEditorWidget;
      const editor = fe.content.editor;
      if (isSelectionEmpty(editor.getSelection())) {
        return editor.model.sharedModel.getSource();
      } else {
        return getSelectionInEditor(editor);
      }
    } else {
      const dw = activeWidget as DocumentWidget;
      return dw?.context?.model?.toString();
    }
  }

  static getCurrentCellContents(): ICellContents {
    const activeDocumentInfo = ActiveDocumentWatcher.activeDocumentInfo;
    const activeWidget = activeDocumentInfo.activeWidget;

    if (activeWidget instanceof NotebookPanel) {
      const np = activeWidget as NotebookPanel;
      const activeCell = np.content.activeCell;
      const input = activeCell.model.sharedModel.source.trim();
      let output = '';
      if (activeCell instanceof CodeCell) {
        output = cellOutputAsText(np.content.activeCell as CodeCell);
      }

      return { input, output };
    }

    return null;
  }

  static fireActiveDocumentChangedEvent() {
    document.dispatchEvent(
      new CustomEvent('copilotSidebar:activeDocumentChanged', {
        detail: {
          activeDocumentInfo: ActiveDocumentWatcher.activeDocumentInfo
        }
      })
    );
  }

  static activeDocumentInfo: IActiveDocumentInfo = {
    language: 'python',
    filename: 'nb-doesnt-exist.ipynb',
    filePath: 'nb-doesnt-exist.ipynb',
    activeWidget: null,
    activeCellIndex: -1,
    selection: null
  };
  private static _watchTimer: any;
  private static _languageRegistry: IEditorLanguageRegistry;
}

class GitHubInlineCompletionProvider
  implements IInlineCompletionProvider<IInlineCompletionItem>
{
  get schema(): ISettingRegistry.IProperty {
    return {
      default: {
        debouncerDelay: 200
      }
    };
  }

  fetch(
    request: CompletionHandler.IRequest,
    context: IInlineCompletionContext
  ): Promise<IInlineCompletionList<IInlineCompletionItem>> {
    let preContent = '';
    let postContent = '';
    const preCursor = request.text.substring(0, request.offset);
    const postCursor = request.text.substring(request.offset);
    let language = ActiveDocumentWatcher.activeDocumentInfo.language;

    if (context.widget instanceof NotebookPanel) {
      const activeCell = context.widget.content.activeCell;
      if (activeCell.model.sharedModel.cell_type === 'markdown') {
        language = 'markdown';
      }
      let activeCellReached = false;

      for (const cell of context.widget.content.widgets) {
        const cellModel = cell.model.sharedModel;
        if (cell === activeCell) {
          activeCellReached = true;
        } else if (!activeCellReached) {
          if (cellModel.cell_type === 'code') {
            preContent += cellModel.source + '\n';
          } else if (cellModel.cell_type === 'markdown') {
            preContent += markdownToComment(cellModel.source) + '\n';
          }
        } else {
          if (cellModel.cell_type === 'code') {
            postContent += cellModel.source + '\n';
          } else if (cellModel.cell_type === 'markdown') {
            postContent += markdownToComment(cellModel.source) + '\n';
          }
        }
      }
    }

    return new Promise((resolve, reject) => {
      const items: IInlineCompletionItem[] = [];

      if (
        GitHubCopilot.getLoginStatus() !== GitHubCopilotLoginStatus.LoggedIn
      ) {
        resolve({ items });
        return;
      }

      if (this._lastRequestInfo) {
        GitHubCopilot.sendWebSocketMessage(
          this._lastRequestInfo.messageId,
          RequestDataType.CancelInlineCompletionRequest,
          { chatId: this._lastRequestInfo.chatId }
        );
      }

      const messageId = UUID.uuid4();
      const chatId = UUID.uuid4();
      this._lastRequestInfo = { chatId, messageId };

      GitHubCopilot.inlineCompletionsRequest(
        chatId,
        messageId,
        preContent + preCursor,
        postCursor + postContent,
        language,
        ActiveDocumentWatcher.activeDocumentInfo.filename,
        {
          emit: (response: any) => {
            if (
              response.type === BackendMessageType.StreamMessage &&
              response.id === this._lastRequestInfo.messageId
            ) {
              items.push({
                insertText: response.data.completions
              });

              resolve({ items });
            } else {
              reject();
            }
          }
        }
      );
    });
  }

  get name(): string {
    return 'Notebook Intelligence';
  }

  get identifier(): string {
    return '@mbektas/notebook-intelligence';
  }

  get icon(): LabIcon.ILabIcon {
    return githuCopilotIcon;
  }

  private _lastRequestInfo: { chatId: string; messageId: string } = null;
}

/**
 * Initialization data for the @mbektas/notebook-intelligence extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: '@mbektas/notebook-intelligence:plugin',
  description: 'Notebook Intelligence',
  autoStart: true,
  requires: [
    ICompletionProviderManager,
    IDocumentManager,
    IDefaultFileBrowser,
    IEditorLanguageRegistry
  ],
  optional: [ISettingRegistry, IStatusBar],
  activate: (
    app: JupyterFrontEnd,
    completionManager: ICompletionProviderManager,
    docManager: IDocumentManager,
    defaultBrowser: IDefaultFileBrowser,
    languageRegistry: IEditorLanguageRegistry,
    settingRegistry: ISettingRegistry | null,
    statusBar: IStatusBar | null
  ) => {
    console.log(
      'JupyterLab extension @mbektas/notebook-intelligence is activated!'
    );

    let openPopover: InlinePromptWidget | null = null;

    new LabIcon({
      name: 'notebook-intelligence:sparkles-icon',
      svgstr: sparklesSvgstr
    });

    completionManager.registerInlineProvider(
      new GitHubInlineCompletionProvider()
    );

    if (settingRegistry) {
      settingRegistry
        .load(plugin.id)
        .then(settings => {
          console.log(
            '@mbektas/notebook-intelligence settings loaded:',
            settings.composite
          );
        })
        .catch(reason => {
          console.error(
            'Failed to load settings for @mbektas/notebook-intelligence.',
            reason
          );
        });
    }

    const waitForFileToBeActive = async (
      filePath: string
    ): Promise<boolean> => {
      const isNotebook = filePath.endsWith('.ipynb');

      return new Promise<boolean>((resolve, reject) => {
        const checkIfActive = () => {
          const activeFilePath =
            ActiveDocumentWatcher.activeDocumentInfo.filePath;
          const filePathToCheck = filePath;
          const currentWidget = app.shell.currentWidget;
          if (
            activeFilePath === filePathToCheck &&
            ((isNotebook &&
              currentWidget instanceof NotebookPanel &&
              currentWidget.content.activeCell &&
              currentWidget.content.activeCell.node.contains(
                document.activeElement
              )) ||
              (!isNotebook &&
                currentWidget instanceof FileEditorWidget &&
                currentWidget.content.editor.hasFocus()))
          ) {
            resolve(true);
          } else {
            setTimeout(checkIfActive, 200);
          }
        };
        checkIfActive();

        waitForDuration(10000).then(() => {
          resolve(false);
        });
      });
    };

    const panel = new Panel();
    panel.id = 'notebook-intelligence-tab';
    panel.title.caption = 'Copilot Chat';
    const sidebarIcon = new LabIcon({
      name: 'ui-components:palette',
      svgstr: sparklesSvgstr
    });
    panel.title.icon = sidebarIcon;
    const sidebar = new ChatSidebar({
      getActiveDocumentInfo: (): IActiveDocumentInfo => {
        return ActiveDocumentWatcher.activeDocumentInfo;
      },
      getActiveSelectionContent: (): string => {
        return ActiveDocumentWatcher.getActiveSelectionContent();
      },
      getCurrentCellContents: (): ICellContents => {
        return ActiveDocumentWatcher.getCurrentCellContents();
      },
      openFile: (path: string) => {
        docManager.openOrReveal(path);
      },
      getApp(): JupyterFrontEnd {
        return app;
      }
    });
    panel.addWidget(sidebar);
    app.shell.add(panel, 'left', { rank: 1000 });
    app.shell.activateById(panel.id);

    app.commands.addCommand(CommandIDs.chatuserInput, {
      execute: args => {
        GitHubCopilot.sendChatUserInput(args.id as string, args.data);
      }
    });

    app.commands.addCommand(CommandIDs.insertAtCursor, {
      execute: args => {
        const currentWidget = app.shell.currentWidget;
        if (currentWidget instanceof NotebookPanel) {
          const activeCell = currentWidget.content.activeCell;
          if (activeCell) {
            applyCodeToSelectionInEditor(
              activeCell.editor,
              args.code as string
            );
            return;
          }
        } else if (currentWidget instanceof FileEditorWidget) {
          applyCodeToSelectionInEditor(
            currentWidget.content.editor,
            args.code as string
          );
          return;
        }

        app.commands.execute('apputils:notify', {
          message:
            'Failed to insert at cursor. Open a notebook or file to insert the code.',
          type: 'error',
          options: { autoClose: true }
        });
      }
    });

    app.commands.addCommand(CommandIDs.addCodeAsNewCell, {
      execute: args => {
        const currentWidget = app.shell.currentWidget;
        if (currentWidget instanceof NotebookPanel) {
          let activeCellIndex = currentWidget.content.activeCellIndex;
          activeCellIndex =
            activeCellIndex === -1
              ? currentWidget.content.widgets.length
              : activeCellIndex + 1;

          currentWidget.model?.sharedModel.insertCell(activeCellIndex, {
            cell_type: 'code',
            metadata: { trusted: true },
            source: args.code as string
          });
          currentWidget.content.activeCellIndex = activeCellIndex;
        } else {
          app.commands.execute('apputils:notify', {
            message: 'Open a notebook to insert the code as new cell',
            type: 'error',
            options: { autoClose: true }
          });
        }
      }
    });

    app.commands.addCommand(CommandIDs.createNewFile, {
      execute: async args => {
        const contents = new ContentsManager();
        const newPyFile = await contents.newUntitled({
          ext: '.py',
          path: defaultBrowser?.model.path
        });
        contents.save(newPyFile.path, {
          content: extractCodeFromMarkdown(args.code as string),
          format: 'text',
          type: 'file'
        });
        docManager.openOrReveal(newPyFile.path);

        await waitForFileToBeActive(newPyFile.path);

        return newPyFile;
      }
    });

    app.commands.addCommand(CommandIDs.createNewNotebookFromPython, {
      execute: async args => {
        let pythonKernelSpec = null;
        const contents = new ContentsManager();
        const kernels = new KernelSpecManager();
        await kernels.ready;
        const kernelspecs = kernels.specs?.kernelspecs;
        if (kernelspecs) {
          for (const key in kernelspecs) {
            const kernelspec = kernelspecs[key];
            if (kernelspec?.language === 'python') {
              pythonKernelSpec = kernelspec;
              break;
            }
          }
        }

        const newNBFile = await contents.newUntitled({
          ext: '.ipynb',
          path: defaultBrowser?.model.path
        });
        const nbFileContent = structuredClone(emptyNotebookContent);
        if (pythonKernelSpec) {
          nbFileContent.metadata = {
            kernelspec: {
              language: 'python',
              name: pythonKernelSpec.name,
              display_name: pythonKernelSpec.display_name
            }
          };
        }

        if (args.code) {
          nbFileContent.cells.push({
            cell_type: 'code',
            metadata: { trusted: true },
            source: [args.code as string],
            outputs: []
          });
        }

        contents.save(newNBFile.path, {
          content: nbFileContent,
          format: 'json',
          type: 'notebook'
        });
        docManager.openOrReveal(newNBFile.path);

        await waitForFileToBeActive(newNBFile.path);

        return newNBFile;
      }
    });

    const isNewEmptyNotebook = (model: ISharedNotebook) => {
      return (
        model.cells.length === 1 &&
        model.cells[0].cell_type === 'code' &&
        model.cells[0].source === ''
      );
    };

    const loggedInToGitHubCopilot = (): boolean => {
      return (
        GitHubCopilot.getLoginStatus() === GitHubCopilotLoginStatus.LoggedIn
      );
    };

    const isActiveCellCodeCell = (): boolean => {
      if (!(app.shell.currentWidget instanceof NotebookPanel)) {
        return false;
      }
      const np = app.shell.currentWidget as NotebookPanel;
      const activeCell = np.content.activeCell;
      return activeCell instanceof CodeCell;
    };

    const isCurrentWidgetFileEditor = (): boolean => {
      return app.shell.currentWidget instanceof FileEditorWidget;
    };

    const addCellToNotebook = (
      filePath: string,
      cellType: 'code' | 'markdown',
      source: string
    ): boolean => {
      const currentWidget = app.shell.currentWidget;
      const notebookOpen =
        currentWidget instanceof NotebookPanel &&
        currentWidget.sessionContext.path === filePath &&
        currentWidget.model;
      if (!notebookOpen) {
        app.commands.execute('apputils:notify', {
          message: `Failed to access the notebook: ${filePath}`,
          type: 'error',
          options: { autoClose: true }
        });
        return false;
      }

      const model = currentWidget.model.sharedModel;

      const newCellIndex = isNewEmptyNotebook(model)
        ? 0
        : model.cells.length - 1;
      model.insertCell(newCellIndex, {
        cell_type: cellType,
        metadata: { trusted: true },
        source
      });

      return true;
    };

    app.commands.addCommand(CommandIDs.addCodeCellToNotebook, {
      execute: args => {
        return addCellToNotebook(
          args.path as string,
          'code',
          args.code as string
        );
      }
    });

    app.commands.addCommand(CommandIDs.addMarkdownCellToNotebook, {
      execute: args => {
        return addCellToNotebook(
          args.path as string,
          'markdown',
          args.markdown as string
        );
      }
    });

    app.commands.addCommand(CommandIDs.openGitHubCopilotLoginDialog, {
      execute: args => {
        let dialog: Dialog<unknown> | null = null;
        const dialogBody = new GitHubCopilotLoginDialogBody({
          onLoggedIn: () => dialog?.dispose()
        });
        dialog = new Dialog({
          title: 'GitHub Copilot Status',
          hasClose: true,
          body: dialogBody,
          buttons: []
        });

        dialog.launch();
      }
    });

    const getPrefixAndSuffixForActiveCell = (): {
      prefix: string;
      suffix: string;
    } => {
      let prefix = '';
      let suffix = '';
      const currentWidget = app.shell.currentWidget;
      if (
        !(
          currentWidget instanceof NotebookPanel &&
          currentWidget.content.activeCell
        )
      ) {
        return { prefix, suffix };
      }

      const activeCellIndex = currentWidget.content.activeCellIndex;
      const numCells = currentWidget.content.widgets.length;
      const maxContext = 0.7 * MAX_TOKENS;

      for (let d = 1; d < numCells; ++d) {
        const above = activeCellIndex - d;
        const below = activeCellIndex + d;
        if (
          (above < 0 && below >= numCells) ||
          getTokenCount(`${prefix} ${suffix}`) >= maxContext
        ) {
          break;
        }

        if (above >= 0) {
          const aboveCell = currentWidget.content.widgets[above];
          const cellModel = aboveCell.model.sharedModel;

          if (cellModel.cell_type === 'code') {
            prefix = cellModel.source + '\n' + prefix;
          } else if (cellModel.cell_type === 'markdown') {
            prefix = markdownToComment(cellModel.source) + '\n' + prefix;
          }
        }

        if (below < numCells) {
          const belowCell = currentWidget.content.widgets[below];
          const cellModel = belowCell.model.sharedModel;

          if (cellModel.cell_type === 'code') {
            suffix += cellModel.source + '\n';
          } else if (cellModel.cell_type === 'markdown') {
            suffix += markdownToComment(cellModel.source) + '\n';
          }
        }
      }

      return { prefix, suffix };
    };

    const getPrefixAndSuffixForFileEditor = (): {
      prefix: string;
      suffix: string;
    } => {
      let prefix = '';
      let suffix = '';
      const currentWidget = app.shell.currentWidget;
      if (!(currentWidget instanceof FileEditorWidget)) {
        return { prefix, suffix };
      }

      const fe = currentWidget as FileEditorWidget;

      const cursor = fe.content.editor.getCursorPosition();
      const offset = fe.content.editor.getOffsetAt(cursor);
      const source = fe.content.editor.model.sharedModel.getSource();
      prefix = source.substring(0, offset);
      suffix = source.substring(offset);

      return { prefix, suffix };
    };

    const generateCodeForCellOrFileEditor = () => {
      const isCodeCell = isActiveCellCodeCell();
      const currentWidget = app.shell.currentWidget;
      let editor: CodeEditor.IEditor;
      let codeInput: HTMLElement = null;
      let scrollEl: HTMLElement = null;
      if (isCodeCell) {
        const np = currentWidget as NotebookPanel;
        const activeCell = np.content.activeCell;
        codeInput = activeCell.node.querySelector('.jp-InputArea-editor');
        if (!codeInput) {
          return;
        }
        scrollEl = np.node.querySelector('.jp-WindowedPanel-outer');
        editor = activeCell.editor;
      } else {
        const fe = currentWidget as FileEditorWidget;
        codeInput = fe.node;
        scrollEl = fe.node.querySelector('.cm-scroller');
        editor = fe.content.editor;
      }

      const getRectAtCursor = (): DOMRect => {
        const selection = editor.getSelection();
        const line = Math.min(selection.end.line + 1, editor.lineCount - 1);
        const coords = editor.getCoordinateForPosition({
          line,
          column: selection.end.column
        });
        const editorRect = codeInput.getBoundingClientRect();
        if (!coords) {
          return editorRect;
        }
        const yOffset = 30;
        const rect: DOMRect = new DOMRect(
          editorRect.left,
          coords.top - yOffset,
          editorRect.right - editorRect.left,
          coords.bottom - coords.top
        );
        return rect;
      };

      const rect = getRectAtCursor();

      const updatePopoverPosition = () => {
        if (openPopover !== null) {
          const rect = getRectAtCursor();
          openPopover.updatePosition(rect);
        }
      };

      const inputResizeObserver = new ResizeObserver(updatePopoverPosition);

      const addPositionListeners = () => {
        inputResizeObserver.observe(codeInput);
        if (scrollEl) {
          scrollEl.addEventListener('scroll', updatePopoverPosition);
        }
      };

      const removePositionListeners = () => {
        inputResizeObserver.unobserve(codeInput);
        if (scrollEl) {
          scrollEl.removeEventListener('scroll', updatePopoverPosition);
        }
      };

      const removePopover = () => {
        if (openPopover !== null) {
          removePositionListeners();
          openPopover = null;
          Widget.detach(inlinePrompt);
        }
      };

      let userPrompt = '';
      let existingCode = '';
      let generatedContent = '';

      let prefix = '',
        suffix = '';
      if (isCodeCell) {
        const ps = getPrefixAndSuffixForActiveCell();
        prefix = ps.prefix;
        suffix = ps.suffix;
      } else {
        const ps = getPrefixAndSuffixForFileEditor();
        prefix = ps.prefix;
        suffix = ps.suffix;
      }
      const selection = editor.getSelection();

      const startOffset = editor.getOffsetAt(selection.start);
      const endOffset = editor.getOffsetAt(selection.end);
      const source = editor.model.sharedModel.getSource();

      if (isCodeCell) {
        prefix += '\n' + source.substring(0, startOffset);
        existingCode = source.substring(startOffset, endOffset);
        suffix = source.substring(endOffset) + '\n' + suffix;
      } else {
        existingCode = source.substring(startOffset, endOffset);
      }

      const applyGeneratedCode = () => {
        generatedContent = extractCodeFromMarkdown(generatedContent);
        applyCodeToSelectionInEditor(editor, generatedContent);
        generatedContent = '';
        removePopover();
      };

      removePopover();

      const inlinePrompt = new InlinePromptWidget(rect, {
        prompt: userPrompt,
        existingCode,
        prefix: prefix,
        suffix: suffix,
        onRequestSubmitted: (prompt: string) => {
          userPrompt = prompt;
          generatedContent = '';
          if (existingCode !== '') {
            return;
          }
          removePopover();
        },
        onRequestCancelled: () => {
          removePopover();
          editor.focus();
        },
        onContentStream: (content: string) => {
          if (existingCode !== '') {
            return;
          }
          generatedContent += content;
        },
        onContentStreamEnd: () => {
          if (existingCode !== '') {
            return;
          }
          applyGeneratedCode();
          editor.focus();
        },
        onUpdatedCodeChange: (content: string) => {
          generatedContent = content;
        },
        onUpdatedCodeAccepted: () => {
          applyGeneratedCode();
          editor.focus();
        }
      });
      openPopover = inlinePrompt;
      addPositionListeners();
      Widget.attach(inlinePrompt, document.body);
    };

    const generateCellCodeCommand: CommandRegistry.ICommandOptions = {
      execute: args => {
        generateCodeForCellOrFileEditor();
      },
      label: 'Generate code',
      isEnabled: () =>
        loggedInToGitHubCopilot() &&
        (isActiveCellCodeCell() || isCurrentWidgetFileEditor())
    };
    app.commands.addCommand(
      CommandIDs.editorGenerateCode,
      generateCellCodeCommand
    );

    const copilotMenuCommands = new CommandRegistry();
    copilotMenuCommands.addCommand(
      CommandIDs.editorGenerateCode,
      generateCellCodeCommand
    );
    copilotMenuCommands.addCommand(CommandIDs.editorExplainThisCode, {
      execute: () => {
        const np = app.shell.currentWidget as NotebookPanel;
        const activeCell = np.content.activeCell;
        const content = activeCell?.model.sharedModel.source || '';
        document.dispatchEvent(
          new CustomEvent('copilotSidebar:runPrompt', {
            detail: {
              type: RunChatCompletionType.ExplainThis,
              content,
              language: ActiveDocumentWatcher.activeDocumentInfo.language,
              filename: ActiveDocumentWatcher.activeDocumentInfo.filename
            }
          })
        );

        app.commands.execute('tabsmenu:activate-by-id', { id: panel.id });
      },
      label: 'Explain code',
      isEnabled: () => loggedInToGitHubCopilot() && isActiveCellCodeCell()
    });
    copilotMenuCommands.addCommand(CommandIDs.editorFixThisCode, {
      execute: () => {
        const np = app.shell.currentWidget as NotebookPanel;
        const activeCell = np.content.activeCell;
        const content = activeCell?.model.sharedModel.source || '';
        document.dispatchEvent(
          new CustomEvent('copilotSidebar:runPrompt', {
            detail: {
              type: RunChatCompletionType.FixThis,
              content,
              language: ActiveDocumentWatcher.activeDocumentInfo.language,
              filename: ActiveDocumentWatcher.activeDocumentInfo.filename
            }
          })
        );

        app.commands.execute('tabsmenu:activate-by-id', { id: panel.id });
      },
      label: 'Fix code',
      isEnabled: () => loggedInToGitHubCopilot() && isActiveCellCodeCell()
    });
    copilotMenuCommands.addCommand(CommandIDs.editorExplainThisOutput, {
      execute: () => {
        const np = app.shell.currentWidget as NotebookPanel;
        const activeCell = np.content.activeCell;
        if (!(activeCell instanceof CodeCell)) {
          return;
        }
        const content = cellOutputAsText(activeCell as CodeCell);
        document.dispatchEvent(
          new CustomEvent('copilotSidebar:runPrompt', {
            detail: {
              type: RunChatCompletionType.ExplainThisOutput,
              content,
              language: ActiveDocumentWatcher.activeDocumentInfo.language,
              filename: ActiveDocumentWatcher.activeDocumentInfo.filename
            }
          })
        );

        app.commands.execute('tabsmenu:activate-by-id', { id: panel.id });
      },
      label: 'Explain output',
      isEnabled: () => {
        if (
          !(
            loggedInToGitHubCopilot() &&
            app.shell.currentWidget instanceof NotebookPanel
          )
        ) {
          return false;
        }
        const np = app.shell.currentWidget as NotebookPanel;
        const activeCell = np.content.activeCell;
        if (!(activeCell instanceof CodeCell)) {
          return false;
        }
        const outputs = activeCell.outputArea.model.toJSON();
        return Array.isArray(outputs) && outputs.length > 0;
      }
    });
    copilotMenuCommands.addCommand(CommandIDs.editorTroubleshootThisOutput, {
      execute: () => {
        const np = app.shell.currentWidget as NotebookPanel;
        const activeCell = np.content.activeCell;
        if (!(activeCell instanceof CodeCell)) {
          return;
        }
        const content = cellOutputAsText(activeCell as CodeCell);
        document.dispatchEvent(
          new CustomEvent('copilotSidebar:runPrompt', {
            detail: {
              type: RunChatCompletionType.TroubleshootThisOutput,
              content,
              language: ActiveDocumentWatcher.activeDocumentInfo.language,
              filename: ActiveDocumentWatcher.activeDocumentInfo.filename
            }
          })
        );

        app.commands.execute('tabsmenu:activate-by-id', { id: panel.id });
      },
      label: 'Troubleshoot errors in output',
      isEnabled: () => {
        if (
          !(
            loggedInToGitHubCopilot() &&
            app.shell.currentWidget instanceof NotebookPanel
          )
        ) {
          return false;
        }
        const np = app.shell.currentWidget as NotebookPanel;
        const activeCell = np.content.activeCell;
        if (!(activeCell instanceof CodeCell)) {
          return false;
        }
        const outputs = activeCell.outputArea.model.toJSON();
        return (
          Array.isArray(outputs) &&
          outputs.length > 0 &&
          outputs.some(output => output.output_type === 'error')
        );
      }
    });

    const copilotContextMenu = new Menu({ commands: copilotMenuCommands });
    copilotContextMenu.id = 'notebook-intelligence:editor-context-menu';
    copilotContextMenu.title.label = 'Copilot';
    copilotContextMenu.title.icon = sidebarIcon;
    copilotContextMenu.addItem({ command: CommandIDs.editorGenerateCode });
    copilotContextMenu.addItem({ command: CommandIDs.editorExplainThisCode });
    copilotContextMenu.addItem({ command: CommandIDs.editorFixThisCode });
    copilotContextMenu.addItem({ command: CommandIDs.editorExplainThisOutput });
    copilotContextMenu.addItem({
      command: CommandIDs.editorTroubleshootThisOutput
    });

    app.contextMenu.addItem({
      type: 'submenu',
      submenu: copilotContextMenu,
      selector: '.jp-Editor',
      rank: 1
    });

    app.contextMenu.addItem({
      type: 'submenu',
      submenu: copilotContextMenu,
      selector: '.jp-OutputArea-child',
      rank: 1
    });

    if (statusBar) {
      const githubCopilotStatusBarItem = new GitHubCopilotStatusBarItem({
        getApp: () => app
      });

      statusBar.registerStatusItem(
        'notebook-intelligence:github-copilot-status',
        {
          item: githubCopilotStatusBarItem,
          align: 'right',
          rank: 100,
          isActive: () => true
        }
      );
    }

    const jlabApp = app as JupyterLab;
    ActiveDocumentWatcher.initialize(jlabApp, languageRegistry);

    GitHubCopilot.initialize();
  }
};

export default plugin;
