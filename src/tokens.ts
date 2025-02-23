// Copyright (c) Mehmet Bektas <mbektasgh@outlook.com>

import { Widget } from '@lumino/widgets';
import { CodeEditor } from '@jupyterlab/codeeditor';

export interface IActiveDocumentInfo {
  activeWidget: Widget | null;
  language: string;
  filename: string;
  filePath: string;
  activeCellIndex: number;
  selection?: CodeEditor.IRange;
}

export interface IChatCompletionResponseEmitter {
  emit: (response: any) => void;
}

export enum RequestDataType {
  ChatRequest = 'chat-request',
  ChatUserInput = 'chat-user-input',
  ClearChatHistory = 'clear-chat-history',
  RunUICommandResponse = 'run-ui-command-response',
  GenerateCode = 'generate-code',
  CancelChatRequest = 'cancel-chat-request',
  InlineCompletionRequest = 'inline-completion-request',
  CancelInlineCompletionRequest = 'cancel-inline-completion-request'
}

export enum BackendMessageType {
  StreamMessage = 'stream-message',
  StreamEnd = 'stream-end',
  RunUICommand = 'run-ui-command'
}

export enum ResponseStreamDataType {
  LLMRaw = 'llm-raw',
  Markdown = 'markdown',
  MarkdownPart = 'markdown-part',
  HTMLFrame = 'html-frame',
  Button = 'button',
  Anchor = 'anchor',
  Progress = 'progress',
  Confirmation = 'confirmation'
}

export enum ContextType {
  Custom = 'custom',
  CurrentFile = 'current-file'
}

export interface IContextItem {
  type: ContextType;
  content: string;
  currentCellContents: ICellContents;
  filePath?: string;
  cellIndex?: number;
  startLine?: number;
  endLine?: number;
}

export interface ICellContents {
  input: string;
  output: string;
}
