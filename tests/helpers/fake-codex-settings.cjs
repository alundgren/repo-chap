module.exports = ({ mode, log }) => {
  const fs = require('node:fs');
  const readline = require('node:readline');
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line), params = message.params ?? {};
    if (log) fs.appendFileSync(log, JSON.stringify(message) + '\n');
    if (mode === 'settings-hang') return;
    if (message.id === undefined) return;
    let result;
    if (message.method === 'initialize') result = {};
    else if (message.method === 'config/read') result = { config: {
      ...(mode === 'custom-instructions' ? { instructions: 'PRIVATE_CUSTOM_INSTRUCTION' } : {}),
      ...(mode === 'model-instructions' ? { model_instructions_file: '/fictional/private.md' } : {}),
      mcp_servers: { ambient: { command: '/fictional/disabled-mcp' } },
    } };
    else if (message.method === 'skills/list') result = { data: [{ cwd: params.cwds[0], skills: [{ path: '/fictional/ambient/SKILL.md' }], errors: mode === 'skills-error' ? ['PRIVATE_SKILL_ERROR'] : [] }] };
    else if (message.method === 'thread/start') result = { model: params.model, instructionSources: mode === 'ambient-global' ? ['/fictional/AGENTS.md'] : [], thread: { id: 'unused-preflight' } };
    else throw new Error('Settings inspection must not send a model turn.');
    send({ id: message.id, result });
  });
};
