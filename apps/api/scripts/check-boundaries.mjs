import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const violations = [];

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? files(path)
      : path.endsWith('.ts')
        ? [path]
        : [];
  });
}

for (const file of files(sourceRoot)) {
  const source = relative(sourceRoot, file).replaceAll('\\', '/');
  const sourceModule = source.match(/^modules\/([^/]+)\//)?.[1];
  const syntax = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  function check(specifier) {
    if (!specifier.startsWith('.')) return;
    const target = relative(sourceRoot, resolve(dirname(file), specifier))
      .replaceAll('\\', '/')
      .replace(/\.js$/, '.ts');
    const targetModule = target.match(/^modules\/([^/]+)\//)?.[1];
    let reason;
    if (
      /^(config|platform)\//.test(source) &&
      (targetModule || /^(app|index)\.ts$/.test(target))
    ) {
      reason =
        'Shared infrastructure cannot depend on business modules or bootstrap.';
    } else if (
      targetModule &&
      targetModule !== sourceModule &&
      !/^modules\/[^/]+\/(index|module)\.ts$/.test(target)
    ) {
      reason =
        'Import another module through its public index.ts or module.ts entry point.';
    } else if (sourceModule && /^(app|index)\.ts$/.test(target)) {
      reason = 'Business modules cannot depend on application bootstrap.';
    } else if (
      /^modules\/[^/]+\/(?:[\w-]+\.)?service\.ts$/.test(source) &&
      (/^config\//.test(target) ||
        /\/(infrastructure\/|routes\.ts$|callbacks\.routes\.ts$)/.test(target))
    ) {
      reason =
        'Application services receive configuration and provider dependencies through construction.';
    }
    if (reason) violations.push(`${source} → ${target}: ${reason}`);
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      check(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      check(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
}

if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('API module dependency boundaries passed.');
}
