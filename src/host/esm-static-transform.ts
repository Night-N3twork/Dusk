type BabelModule = typeof import('@babel/standalone');

let babelModule: Promise<BabelModule> | undefined;

const loadBabel = (): Promise<BabelModule> => {
  if (!babelModule) {
    babelModule = import('@babel/standalone');
    void babelModule.catch(() => { babelModule = undefined; });
  }
  return babelModule;
};

interface SyntaxNode {
  type?: string;
  [key: string]: unknown;
}

interface ModuleMetadata {
  exports: string[];
  imports: Record<string, string[]>;
  stars: string[];
}

const isSyntaxNode = (value: unknown): value is SyntaxNode =>
  typeof value === 'object' && value !== null;

const hasTopLevelAwait = (node: SyntaxNode): boolean => {
  if (node.type === 'AwaitExpression') return true;
  if (node.type === 'ForOfStatement' && node['await'] === true) return true;
  if (node.type?.endsWith('FunctionExpression') || node.type?.endsWith('FunctionDeclaration') || node.type === 'ArrowFunctionExpression' || node.type?.endsWith('Method')) return false;
  return Object.values(node).some((value) =>
    Array.isArray(value)
      ? value.some((child) => isSyntaxNode(child) && hasTopLevelAwait(child))
      : isSyntaxNode(value) && hasTopLevelAwait(value));
};

const identifierName = (node: SyntaxNode | undefined): string | undefined => {
  const value = node?.['name'] ?? node?.['value'];
  return typeof value === 'string' ? value : undefined;
};

const bindingNames = (node: SyntaxNode | undefined): string[] => {
  if (!node) return [];
  if (node.type === 'Identifier') return [identifierName(node)!];
  if (node.type === 'RestElement') return bindingNames(node['argument'] as SyntaxNode | undefined);
  if (node.type === 'AssignmentPattern') return bindingNames(node['left'] as SyntaxNode | undefined);
  if (node.type === 'ObjectPattern') {
    const properties = node['properties'];
    return Array.isArray(properties) ? properties.filter(isSyntaxNode).flatMap((property) =>
      property.type === 'RestElement' ? bindingNames(property) : bindingNames(property['value'] as SyntaxNode | undefined)) : [];
  }
  if (node.type === 'ArrayPattern') {
    const elements = node['elements'];
    return Array.isArray(elements) ? elements.filter(isSyntaxNode).flatMap(bindingNames) : [];
  }
  return [];
};

const metadataFor = (ast: SyntaxNode): ModuleMetadata => {
  const metadata: ModuleMetadata = { exports: [], imports: {}, stars: [] };
  const body = (ast['program'] as SyntaxNode | undefined)?.['body'];
  if (!Array.isArray(body)) return metadata;
  const addExport = (name: string | undefined): void => { if (name && !metadata.exports.includes(name)) metadata.exports.push(name); };
  const addImport = (specifier: string, name: string | undefined): void => {
    if (!name) return;
    const names = metadata.imports[specifier] ?? (metadata.imports[specifier] = []);
    if (!names.includes(name)) names.push(name);
  };
  for (const statement of body.filter(isSyntaxNode)) {
    if (statement.type === 'ImportDeclaration') {
      const specifier = identifierName(statement['source'] as SyntaxNode | undefined);
      const specifiers = statement['specifiers'];
      if (!specifier || !Array.isArray(specifiers)) continue;
      for (const binding of specifiers.filter(isSyntaxNode)) {
        if (binding.type !== 'ImportNamespaceSpecifier') addImport(specifier, binding.type === 'ImportDefaultSpecifier' ? 'default' : identifierName(binding['imported'] as SyntaxNode | undefined));
      }
    } else if (statement.type === 'ExportDefaultDeclaration') {
      addExport('default');
    } else if (statement.type === 'ExportAllDeclaration') {
      const source = identifierName(statement['source'] as SyntaxNode | undefined);
      if (source) metadata.stars.push(source);
    } else if (statement.type === 'ExportNamedDeclaration') {
      const declaration = statement['declaration'] as SyntaxNode | undefined;
      if (declaration?.type === 'VariableDeclaration') {
        const declarations = declaration['declarations'];
        if (Array.isArray(declarations)) for (const binding of declarations.filter(isSyntaxNode)) for (const name of bindingNames(binding['id'] as SyntaxNode | undefined)) addExport(name);
      } else if (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') {
        addExport(identifierName(declaration['id'] as SyntaxNode | undefined));
      }
      const specifiers = statement['specifiers'];
      const source = identifierName(statement['source'] as SyntaxNode | undefined);
      if (Array.isArray(specifiers)) for (const binding of specifiers.filter(isSyntaxNode)) {
        if (source) addImport(source, identifierName(binding['local'] as SyntaxNode | undefined));
        addExport(identifierName(binding['exported'] as SyntaxNode | undefined));
      }
    }
  }
  return metadata;
};

export const transformStaticImports = async (source: string): Promise<string> => {
  const Babel = await loadBabel();
  const parsed = Babel.transform(source, { ast: true, code: false, sourceType: 'module' });
  const ast = parsed.ast;
  if (!ast) throw new Error('Unable to parse ESM module');
  const result = Babel.transform(source, {
    sourceType: 'module',
    plugins: ['transform-modules-systemjs', 'transform-dynamic-import'],
  });
  if (!result?.code) throw new Error('Unable to compile ESM module');
  return `${result.code}\nglobalThis.__duskSystemMetadata = ${JSON.stringify(metadataFor(ast as unknown as SyntaxNode))};`;
};

const importMetaPlugin = ({ types }: { types: { identifier(name: string): unknown } }) => ({
  visitor: {
    MetaProperty(path: { node: { meta: { name: string }; property: { name: string } }; replaceWith(node: unknown): void }) {
      if (path.node.meta.name === 'import' && path.node.property.name === 'meta') path.replaceWith(types.identifier('__duskImportMeta'));
    },
  },
});

export const transformEsmToCommonJs = async (source: string, path: string): Promise<string> => {
  const Babel = await loadBabel();
  const parsed = Babel.transform(source, { ast: true, code: false, sourceType: 'module' });
  if (!parsed.ast) throw new Error('Unable to parse ESM module');
  if (hasTopLevelAwait((parsed.ast as unknown as SyntaxNode)['program'] as SyntaxNode)) {
    throw new Error(`ERR_REQUIRE_ASYNC_MODULE: require() cannot be used on an ESM graph with top-level await. Use import() instead. From ${path}`);
  }
  const result = Babel.transform(source, {
    sourceType: 'module',
    plugins: [importMetaPlugin, ['transform-modules-commonjs', { importInterop: 'node' }]],
  });
  if (!result?.code) throw new Error('Unable to compile ESM module');
  return result.code;
};

export const prepareModuleSource = async (source: string, path: string, mode: unknown): Promise<string> => {
  if (path.endsWith('.json')) return source;
  if (mode === 'import') return transformStaticImports(source);
  if (mode === 'require-esm') return transformEsmToCommonJs(source, path);
  return source;
};
