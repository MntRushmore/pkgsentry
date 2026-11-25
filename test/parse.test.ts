import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseInstallCommand, parseNpmSpec, parsePySpec, splitShell } from '../src/parse.js';

const pkgs = (cmd: string, cwd?: string) =>
  parseInstallCommand(cmd, cwd).packages.map((p) => `${p.ecosystem}:${p.name}${p.version ? '@' + p.version : ''}`);

describe('splitShell', () => {
  it('splits on operators and respects quotes', () => {
    expect(splitShell(`cd app && npm i "a b" 'c;d' e\\ f; echo hi | cat`)).toEqual([
      ['cd', 'app'],
      ['npm', 'i', 'a b', 'c;d', 'e f'],
      ['echo', 'hi'],
      ['cat'],
    ]);
  });

  it('drops redirections and comments', () => {
    expect(splitShell('npm i foo 2>&1 > out.log # comment && rm -rf /')).toEqual([['npm', 'i', 'foo']]);
    expect(splitShell('pip install x &>/dev/null')).toEqual([['pip', 'install', 'x']]);
  });

  it('handles line continuations', () => {
    expect(splitShell('pip install \\\n  requests \\\n  flask')).toEqual([['pip', 'install', 'requests', 'flask']]);
  });
});

describe('parseNpmSpec', () => {
  it.each([
    ['lodash', 'lodash', undefined],
    ['lodash@4.17.21', 'lodash', '4.17.21'],
    ['lodash@^4', 'lodash', '^4'],
    ['@types/node', '@types/node', undefined],
    ['@types/node@20', '@types/node', '20'],
    ['my-alias@npm:real-pkg@1.0.0', 'real-pkg', '1.0.0'],
  ])('%s', (spec, name, version) => {
    const r = parseNpmSpec(spec) as { name?: string; version?: string };
    expect([r.name, r.version]).toEqual([name, version]);
  });

  it.each(['./local', '../x', '/abs/path', 'file:../x', 'git+https://github.com/a/b.git', 'github:a/b', 'user/repo', 'https://x.com/p.tgz', 'pkg.tgz', 'jsr:@std/path'])(
    'skips %s',
    (spec) => {
      expect(parseNpmSpec(spec)).toHaveProperty('reason');
    },
  );
});

describe('parsePySpec', () => {
  it.each([
    ['requests', 'requests', undefined],
    ['requests==2.32.3', 'requests', '2.32.3'],
    ['requests>=2,<3', 'requests', '>=2,<3'],
    ['uvicorn[standard]', 'uvicorn', undefined],
    ['uvicorn[standard]==0.30.0', 'uvicorn', '0.30.0'],
    ['django ; python_version >= "3.8"', 'django', undefined],
    ['fastapi@^0.110', 'fastapi', '^0.110'],
    ['fastapi@latest', 'fastapi', undefined],
    ['Flask_Login~=0.6', 'Flask_Login', '~=0.6'],
  ])('%s', (spec, name, version) => {
    const r = parsePySpec(spec) as { name?: string; version?: string };
    expect([r.name, r.version]).toEqual([name, version]);
  });

  it.each(['./pkg', '.', 'pkg @ https://x.com/p.whl', 'git+https://github.com/a/b', 'dist/x-1.0-py3-none-any.whl'])('skips %s', (spec) => {
    expect(parsePySpec(spec)).toHaveProperty('reason');
  });
});

describe('npm family', () => {
  it.each([
    ['npm install lodash', ['npm:lodash']],
    ['npm i -D typescript @types/node@20', ['npm:typescript', 'npm:@types/node@20']],
    ['npm install --save-dev --registry https://r.example.com foo', ['npm:foo']],
    ['npm add -w packages/app zod', ['npm:zod']],
    ['npm ci', []],
    ['npm install', []],
    ['npm run build', []],
    ['pnpm add react react-dom', ['npm:react', 'npm:react-dom']],
    ['pnpm --filter web add axios', ['npm:axios']],
    ['npm --prefix ./app install dayjs', ['npm:dayjs']],
    ['pnpm add --filter web axios', ['npm:axios']],
    ['yarn add express@5', ['npm:express@5']],
    ['yarn global add serve', ['npm:serve']],
    ['bun add hono', ['npm:hono']],
    ['bun a elysia', ['npm:elysia']],
    ['bun install zod', ['npm:zod']],
    ['bun run dev', []],
  ])('%s', (cmd, expected) => {
    expect(pkgs(cmd)).toEqual(expected);
  });

  it('marks bare installs as installs with no packages', () => {
    expect(parseInstallCommand('npm install').isInstall).toBe(true);
    expect(parseInstallCommand('npm test').isInstall).toBe(false);
  });
});

describe('runners (npx, dlx, uvx)', () => {
  it.each([
    ['npx create-next-app@latest my-app --ts', ['npm:create-next-app@latest']],
    ['npx -y cowsay hello', ['npm:cowsay']],
    ['npx --package=@angular/cli ng new app', ['npm:@angular/cli']],
    ['npx -p typescript -p ts-node ts-node x.ts', ['npm:typescript', 'npm:ts-node']],
    ['pnpm dlx shadcn@latest init', ['npm:shadcn@latest']],
    ['yarn dlx create-vite', ['npm:create-vite']],
    ['bunx prisma generate', ['npm:prisma']],
    ['bun x prisma generate', ['npm:prisma']],
    ['npm exec -- eslint .', ['npm:eslint']],
    ['uvx ruff check .', ['pypi:ruff']],
    ['uvx --from httpie http GET x', ['pypi:httpie']],
    ['uvx --with numpy ipython', ['pypi:numpy', 'pypi:ipython']],
    ['uv tool run black .', ['pypi:black']],
    ['uv run --with rich script.py', ['pypi:rich']],
    ['uv run script.py', []],
  ])('%s', (cmd, expected) => {
    expect(pkgs(cmd)).toEqual(expected);
  });
});

describe('python family', () => {
  it.each([
    ['pip install requests', ['pypi:requests']],
    ['pip3 install -U "fastapi[all]>=0.100" uvicorn', ['pypi:fastapi@>=0.100', 'pypi:uvicorn']],
    ['python -m pip install --upgrade pip', ['pypi:pip']],
    ['python3.12 -m pip install numpy==2.1.0', ['pypi:numpy@2.1.0']],
    ['pip install -i https://test.pypi.org/simple/ foo', ['pypi:foo']],
    ['pip install -e . black', ['pypi:black']],
    ['pip install --user --no-cache-dir torch', ['pypi:torch']],
    ['pip list', []],
    ['uv pip install pandas polars', ['pypi:pandas', 'pypi:polars']],
    ['uv add httpx --dev', ['pypi:httpx']],
    ['uv add --group lint ruff', ['pypi:ruff']],
    ['uv tool install llm', ['pypi:llm']],
    ['poetry add django@^5.0 celery', ['pypi:django@^5.0', 'pypi:celery']],
    ['poetry add -G dev pytest', ['pypi:pytest']],
    ['pdm add flask', ['pypi:flask']],
    ['pipx install poetry', ['pypi:poetry']],
    ['pipx run --spec black==24.1.0 black .', ['pypi:black@24.1.0']],
    ['pipx inject myvenv rich', ['pypi:rich']],
  ])('%s', (cmd, expected) => {
    expect(pkgs(cmd)).toEqual(expected);
  });

  it('reads requirements files, including nested ones, relative to cd', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pkgsentry-req-'));
    mkdirSync(path.join(dir, 'svc'));
    writeFileSync(
      path.join(dir, 'svc', 'requirements.txt'),
      ['# deps', 'requests==2.32.3  # pinned', 'flask>=3 \\', '  ; python_version > "3.8"', '-r base.txt', '-e ./local', '--index-url https://x', 'numpy --hash=sha256:abc', ''].join('\n'),
    );
    writeFileSync(path.join(dir, 'svc', 'base.txt'), 'pydantic\n');
    expect(pkgs('cd svc && pip install -r requirements.txt', dir)).toEqual([
      'pypi:requests@2.32.3',
      'pypi:flask@>=3',
      'pypi:pydantic',
      'pypi:numpy',
    ]);
  });

  it('reports unreadable requirements files as skipped', () => {
    const r = parseInstallCommand('pip install -r nope.txt', os.tmpdir());
    expect(r.skipped).toEqual([{ spec: '-r nope.txt', reason: "couldn't read requirements file" }]);
  });
});

describe('shell wrappers', () => {
  it.each([
    ['cd web && npm i axios && cd ../api && pip install requests', ['npm:axios', 'pypi:requests']],
    ['CI=1 NODE_ENV=dev npm install left-pad', ['npm:left-pad']],
    ['sudo -E npm install -g pm2', ['npm:pm2']],
    ['sudo -u deploy pip install gunicorn', ['pypi:gunicorn']],
    [`bash -c "npm i foo && pip install bar"`, ['npm:foo', 'pypi:bar']],
    ['/usr/local/bin/pip install six', ['pypi:six']],
    ['echo "npm install fake" > notes.txt', []],
    ['git commit -m "pip install requests"', []],
    ['npm i a; npm i a', ['npm:a']],
  ])('%s', (cmd, expected) => {
    expect(pkgs(cmd)).toEqual(expected);
  });

  it('collects skipped specs', () => {
    const r = parseInstallCommand('npm i ./local github:a/b lodash');
    expect(r.packages.map((p) => p.name)).toEqual(['lodash']);
    expect(r.skipped.map((s) => s.spec)).toEqual(['./local', 'github:a/b']);
  });
});
