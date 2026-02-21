import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

function extractApiInvokes(apiSource) {
  const commands = new Set();
  const regex = /invoke(?:<[^>]+>)?\('([a-z0-9_]+)'/gi;
  let match;
  while ((match = regex.exec(apiSource)) !== null) {
    commands.add(match[1]);
  }
  return commands;
}

function extractRegisteredCommands(mainSource) {
  const commands = new Set();
  const regex = /commands::[a-z0-9_]+::([a-z0-9_]+)/g;
  let match;
  while ((match = regex.exec(mainSource)) !== null) {
    commands.add(match[1]);
  }
  return commands;
}

describe('API command contract', () => {
  it('ensures every ApiService invoke command is registered in tauri main handler', () => {
    const repoRoot = process.cwd();
    const apiPath = path.join(repoRoot, 'src', 'services', 'api.ts');
    const mainPath = path.join(repoRoot, 'src-tauri', 'src', 'main.rs');

    const apiSource = fs.readFileSync(apiPath, 'utf8');
    const mainSource = fs.readFileSync(mainPath, 'utf8');

    const apiCommands = extractApiInvokes(apiSource);
    const registeredCommands = extractRegisteredCommands(mainSource);

    const missing = [...apiCommands].filter((cmd) => !registeredCommands.has(cmd));

    expect(missing).toEqual([]);
  });
});
