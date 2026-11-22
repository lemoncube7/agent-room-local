'use strict';
const {execFile} = require('node:child_process');

function runCodex(project, prompt, session) {
  const args = session
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', session, '-']
    : ['exec', '--json', '--skip-git-repo-check', '-'];
  return new Promise((resolve, reject) => {
    const child=execFile(process.env.AGENT_ROOM_CODEX || 'codex', args, {
      cwd: project, windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => {
      const events = stdout.split('\n').flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const id = session || events.find(event => event.type === 'thread.started')?.thread_id;
      const reply = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message')
        .map(event => event.item.text).filter(Boolean).at(-1);
      if (error || !id || !reply) {
        return reject(new Error(error?.code === 'ENOENT'
          ? 'Codex CLI를 찾지 못했어요.'
          : 'Codex CLI가 답변을 완료하지 못했어요. 프로젝트 신뢰 설정과 CLI 로그인을 확인하세요.'));
      }
      resolve({id, reply});
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(prompt);
  });
}

module.exports = {runCodex};
