'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');
const { HELP, COMMANDS } = require('./lib/help');

/**
 * Returns the source between two markers.
 *
 * @param {string} file file name
 * @param {string} from start marker
 * @param {string} to end marker
 * @returns {string} source
 */
function slice(file, from, to) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  expect(start, from).to.be.greaterThan(0);
  expect(end, to).to.be.greaterThan(start);
  return source.slice(start, end);
}

/** The commands onMessage accepts and the ones the PIN manager handles */
function handledCommands() {
  const onMessage = slice('main.js', '  async onMessage(obj) {', '\n  }\n');
  const accepted = [...onMessage.matchAll(/obj\.command === '([^']+)'/g)].map((m) => m[1]);
  const list = /const commands = \[([^\]]+)\]/.exec(onMessage);
  expect(list).to.not.equal(null);
  accepted.push(...[...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const handled = slice('lib/pinManager.js', '  async handleCommand(command, message) {', '      default:');
  const cases = [...handled.matchAll(/case '([^']+)':/g)].map((m) => m[1]);
  return { accepted, cases };
}

const named = (text, command) => new RegExp(`(^|[^\\w.])${command}(?![\\w])`).test(text);

describe('help', () => {
  it('lists exactly the commands the instance answers, each once', () => {
    const listed = COMMANDS.map((c) => c.command);
    const { accepted, cases } = handledCommands();
    expect(new Set(listed).size).to.equal(listed.length);
    expect([...listed].sort()).to.deep.equal([...new Set(accepted)].sort());
    expect([...cases, 'help'].sort()).to.deep.equal([...listed].sort());
  });

  it('names every command and every remote state', () => {
    for (const { command } of COMMANDS.filter((c) => c.command !== 'help')) {
      expect(named(HELP, command), command).to.equal(true);
    }
    const remotes = slice('main.js', '  async createRemoteObjects(id) {', '    for (const [command, common]');
    const states = [...remotes.matchAll(/^ {6}(\w+): \{/gm)].map((m) => m[1]);
    expect(states).to.include.members(['open', 'unlock', 'pull', 'refresh']);
    for (const state of states) {
      expect(HELP).to.include(`remote.${state}`);
    }
  });

  it('marks the commands that need the request of the user as write', () => {
    const rules = HELP.slice(HELP.indexOf('How to talk to the user:'));
    for (const { command, write } of COMMANDS) {
      if (named(rules, command)) {
        expect(write, command).to.equal(true);
      }
    }
    for (const word of ['remote.open true', 'remote.unlock', 'remote.pull', 'NEVER without']) {
      expect(rules).to.include(word);
    }
  });

  it('keeps the lines short', () => {
    for (const line of HELP.split('\n')) {
      expect(line.length, line).to.be.at.most(120);
    }
  });
});
