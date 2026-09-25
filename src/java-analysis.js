      function javaChild(node, name) {
        return node && node.children && node.children[name] && node.children[name][0];
      }

      function createJavaModel(lex) {
        const parsed = lex.java;
        const offsets = sourceLineOffsets(lex.lines);
        const position = node => (node.location ? node.location.startOffset : node.startOffset) - parsed.offset;
        const end = node => (node.location ? node.location.endOffset : node.endOffset) - parsed.offset + 1;
        const text = node => node ? lex.source.slice(Math.max(0, position(node)), end(node)).trim() : '';
        const codeSource = lex.noComments.join('\n');
        const code = node => node ? codeSource.slice(Math.max(0, position(node)), end(node)).replace(/\s+/g, '') : '';
        const typeCode = node => {
          const raw = code(node);
          if (!raw.includes('@')) return raw;
          // Annotation arguments can contain strings, arrays and annotations.
          // Use CST ranges to remove them without confusing type dimensions.
          const ranges = [];
          const pending = [node];
          const start = Math.max(0, position(node));
          while (pending.length) {
            const current = pending.pop();
            if (current.name === 'annotation') ranges.push({ start: position(current) - start, end: end(current) - start });
            else for (const child of Object.values(current.children).flat()) if (child.name) pending.push(child);
          }
          return maskSource(codeSource.slice(start, end(node)), ranges).replace(/\s+/g, '');
        };
        const root = { parent: null, bindings: new Map(), methods: new Map(), types: new Map(), kind: 'root' };
        const entries = [];
        const parents = new Map();
        const scopes = new Map();
        const classes = [];
        const typeNodes = new Set(['normalClassDeclaration', 'normalInterfaceDeclaration', 'enumDeclaration', 'recordDeclaration', 'annotationInterfaceDeclaration']);
        const scopeNodes = new Set([...typeNodes, 'methodDeclaration', 'interfaceMethodDeclaration', 'constructorDeclaration', 'compactConstructorDeclaration', 'block', 'switchBlock', 'tryWithResourcesStatement', 'basicForStatement', 'enhancedForStatement', 'ifStatement', 'whileStatement', 'catchClause', 'lambdaExpression']);
        const pending = [{ node: parsed.cst, parent: null, scope: root }];
        while (pending.length) {
          let { node, parent, scope } = pending.pop();
          // Resource names are unavailable in catch/finally and after the try.
          if (parent?.name === 'tryWithResourcesStatement' && ['catches', 'finally'].includes(node.name)) scope = scope.parent;
          parents.set(node, parent);
          const anonymousClass = node.name === 'classBody' && parent && ['unqualifiedClassInstanceCreationExpression', 'enumConstant'].includes(parent.name);
          if (scopeNodes.has(node.name) || anonymousClass) {
            scope = { parent: scope, bindings: new Map(), methods: new Map(), types: new Map(), kind: typeNodes.has(node.name) || anonymousClass ? 'class' : node.name, node };
            if (scope.kind === 'class') {
              const identifier = javaChild(javaChild(node, 'typeIdentifier'), 'Identifier') || javaChild(node, 'Identifier');
              scope.id = identifier;
              scope.name = identifier && identifier.image;
              scope.extends = typeCode(javaChild(node, 'classExtends')).replace(/^extends/, '').replace(/<.*$/, '');
              if (scope.name) { scope.parent.types.set(scope.name, scope); classes.push(scope); }
            }
          }
          if (node.name === 'typeParameter') {
            const id = javaChild(javaChild(node, 'typeIdentifier'), 'Identifier');
            if (id) scope.types.set(id.image, { kind: 'typeParameter' });
          }
          if (node.name === 'importDeclaration' && !node.children.Star) {
            const imported = code(javaChild(node, 'packageOrTypeName'));
            const name = imported.split('.').pop();
            if (name && imported !== `java.lang.${name}`) root.types.set(name, { kind: 'typeParameter' });
          }
          scopes.set(node, scope);
          entries.push(node);
          const children = Object.values(node.children).flat().filter(child => child.name).sort((a, b) => b.location.startOffset - a.location.startOffset);
          for (const child of children) pending.push({ node: child, parent: node, scope });
        }
        const ancestor = (node, predicate) => {
          for (let current = parents.get(node); current; current = parents.get(current)) if (predicate(current)) return current;
          return null;
        };
        const classScope = scope => {
          for (let current = scope; current; current = current.parent) if (current.kind === 'class') return current;
          return null;
        };
        const resolveType = (name, scope) => {
          for (let current = scope; current; current = current.parent) {
            if (current.types.has(name)) return current.types.get(name);
          }
          return null;
        };
        const superClass = scope => scope && resolveType(scope.extends, scope.parent);
        const fields = (scope, name, seen = new Set()) => {
          if (!scope || scope.kind === 'typeParameter' || seen.has(scope)) return null;
          seen.add(scope);
          return scope.bindings.get(name) || fields(superClass(scope), name, seen);
        };
        const lookup = (name, scope, offset, fieldOnly = false) => {
          if (fieldOnly) return fields(classScope(scope), name);
          for (let current = scope; current; current = current.parent) {
            const pattern = current.patterns?.get(name)?.findLast(binding => binding.ranges.some(([start, end]) => start <= offset && offset < end));
            if (pattern) return pattern;
            const binding = current.kind === 'class' ? fields(current, name) : current.bindings.get(name);
            if (binding && (binding.field || binding.parameter || binding.start <= offset)) return binding;
          }
          return null;
        };
        const declarations = [];
        const patternNodes = new Map();
        const registerPattern = (scope, binding) => {
          scope.patterns ||= new Map();
          const values = scope.patterns.get(binding.name) || [];
          if (!values.includes(binding)) values.push(binding);
          scope.patterns.set(binding.name, values);
        };
        const methods = [];
        for (const node of entries) {
          if (node.name === 'methodHeader') {
            const declarator = javaChild(node, 'methodDeclarator');
            const id = javaChild(declarator, 'Identifier');
            if (!id) continue;
            const returnType = typeCode(javaChild(node, 'result')) + typeCode(javaChild(declarator, 'dims'));
            const owner = classScope(scopes.get(node)) || root;
            const values = owner.methods.get(id.image) || [];
            values.push({ type: returnType, scope: scopes.get(node) });
            owner.methods.set(id.image, values);
            methods.push({ id, returnType, scope: scopes.get(node) });
          }
          if (!['variableDeclaratorId', 'variableArityParameter', 'recordComponent', 'variableArityRecordComponent', 'lambdaParameters', 'conciseLambdaParameter'].includes(node.name)) continue;
          const id = javaChild(node, 'Identifier');
          if (!id) continue;
          const implicitLambda = ['lambdaParameters', 'conciseLambdaParameter'].includes(node.name);
          const declaration = implicitLambda || ['variableArityParameter', 'recordComponent'].includes(node.name) ? node : ancestor(node, value => value.children.unannType || value.children.localVariableType || value.children.catchType || value.children.lambdaParameterType);
          if (!declaration) continue;
          const typeNode = javaChild(declaration, 'unannType') || javaChild(declaration, 'localVariableType') || javaChild(declaration, 'catchType') || javaChild(declaration, 'lambdaParameterType');
          let type = implicitLambda ? 'unknown' : typeCode(typeNode) + typeCode(javaChild(node, 'dims')) + (/^variableArity/.test(node.name) ? '[]' : '');
          const declarator = ancestor(node, value => value.name === 'variableDeclarator');
          const initializer = javaChild(declarator, 'variableInitializer');
          const field = ['fieldDeclaration', 'constantDeclaration', 'recordComponent'].includes(declaration.name);
          const parameter = implicitLambda || /Parameter|recordComponent|catchFormal/.test(declaration.name);
          let scope = scopes.get(node);
          if (field) scope = classScope(scope) || scope;
          const modifiers = (declaration.children.fieldModifier || declaration.children.constantModifier || []).map(text).join(' ');
          const constant = declaration.name === 'constantDeclaration' || field && /\bstatic\b/.test(modifiers) && /\bfinal\b/.test(modifiers);
          const binding = { name: id.image, id, type, initializer, field, parameter, constant, start: position(id), scope };
          const pattern = ancestor(node, value => value.name === 'typePattern');
          if (pattern) {
            binding.ranges = [];
            patternNodes.set(pattern, binding);
            registerPattern(scope, binding);
          } else scope.bindings.set(id.image, binding);
          if (declaration.name === 'recordComponent') scope.methods.set(id.image, [{ type, scope }]);
          declarations.push(binding);
        }
        const tokens = parsed.tokens.filter(token => position(token) >= 0 && end(token) <= lex.source.length);
        const tokenOffsets = tokens.map(position);
        const tokensFor = node => {
          if (!node || !tokens.length) return [];
          const start = position(node);
          let index = Math.max(0, lineAtOffset(tokenOffsets, start) - 1);
          while (index < tokens.length && position(tokens[index]) < start) index++;
          const result = [];
          while (index < tokens.length && position(tokens[index]) < end(node)) result.push(tokens[index++]);
          return result;
        };
        const normalizeType = (type, scope) => {
          const dimensions = type?.match(/(?:\[\])+$/)?.[0] || '';
          if (dimensions) return normalizeType(type.slice(0, -dimensions.length), scope) + dimensions;
          if (type === 'java.lang.String' || type === 'String' && !resolveType('String', scope)) return 'string';
          if (type === 'boolean' || type === 'java.lang.Boolean' || type === 'Boolean' && !resolveType('Boolean', scope)) return 'boolean';
          return type || 'unknown';
        };
        const methodType = (owner, name, seen = new Set()) => {
          if (!owner || seen.has(owner)) return null;
          if (owner.kind === 'typeParameter') return 'unknown';
          seen.add(owner);
          const methods = owner.methods.get(name);
          const types = methods && new Set(methods.map(method => normalizeType(method.type, method.scope)));
          return types ? types.size === 1 ? [...types][0] : 'unknown' : methodType(superClass(owner), name, seen);
        };
        const typeCache = new Map();
        const precedence = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, 'instanceof': 7, '<<': 8, '>>': 8, '>>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
        // Pattern variables exist only where the condition proves a match.
        // Track boolean facts and source ranges without evaluating pasted code.
        const flowCache = new Map();
        const union = (a, b) => new Set([...a, ...b]);
        const intersection = (a, b) => new Set([...a].filter(value => b.has(value)));
        const makeFlow = node => ({ yes: new Set(), no: new Set(), start: position(node), end: end(node) });
        const allow = (bindings, start, end) => { for (const binding of bindings) binding.ranges.push([start, end]); };
        const flow = (node, depth = 0) => {
          if (!node) return { yes: new Set(), no: new Set() };
          if (flowCache.has(node)) return flowCache.get(node);
          let result = makeFlow(node);
          flowCache.set(node, result);
          if (depth > 80) return result;
          const children = Object.values(node.children || {}).flat().filter(child => child.name);
          if (patternNodes.has(node)) result.yes.add(patternNodes.get(node));
          else if (node.name === 'binaryExpression') {
            const parts = Object.values(node.children).flat().sort((a, b) => position(a) - position(b));
            const values = [], operators = [];
            const reduce = () => {
              const operator = operators.pop();
              const right = values.pop() || makeFlow(node), left = values.pop() || makeFlow(node);
              const value = { yes: new Set(), no: new Set(), start: left.start, end: right.end };
              if (operator === 'instanceof') value.yes = right.yes;
              else if (operator === '&&') {
                allow(left.yes, right.start, right.end);
                value.yes = union(left.yes, right.yes);
                value.no = intersection(left.no, union(left.yes, right.no));
              } else if (operator === '||') {
                allow(left.no, right.start, right.end);
                value.yes = intersection(left.yes, union(left.no, right.yes));
                value.no = union(left.no, right.no);
              }
              values.push(value);
            };
            for (const part of parts) {
              const operator = part.image || (part.name === 'shiftOperator' ? code(part) : '');
              if (Object.hasOwn(precedence, operator)) {
                while (operators.length && precedence[operators.at(-1)] >= precedence[operator]) reduce();
                operators.push(operator);
              } else values.push(flow(part, depth + 1));
            }
            while (operators.length) reduce();
            if (values.length === 1) result = { ...values[0], start: position(node), end: end(node) };
          } else if (node.name === 'unaryExpression') {
            const operators = node.children.UnaryPrefixOperator || [];
            if (operators.every(token => token.image === '!') && !node.children.UnarySuffixOperator && children.length === 1) {
              const inner = flow(children[0], depth + 1);
              result.yes = operators.length % 2 ? inner.no : inner.yes;
              result.no = operators.length % 2 ? inner.yes : inner.no;
            }
          } else if (['expression', 'conditionalExpression', 'primary', 'primaryPrefix', 'parenthesisExpression', 'pattern'].includes(node.name) && children.length === 1 && !node.children.QuestionMark) {
            const inner = flow(children[0], depth + 1);
            result.yes = inner.yes; result.no = inner.no;
          }
          flowCache.set(node, result);
          return result;
        };
        const exits = (node, depth = 0) => {
          if (!node || depth > 80) return false;
          if (['returnStatement', 'throwStatement'].includes(node.name)) return true;
          const children = Object.values(node.children || {}).flat().filter(child => child.name);
          if (node.name === 'blockStatements') return exits(children.at(-1), depth + 1);
          return ['statement', 'statementWithoutTrailingSubstatement', 'block', 'blockStatement'].includes(node.name)
            && children.length === 1 && exits(children[0], depth + 1);
        };
        if (patternNodes.size) for (const node of entries) {
          if (node.name === 'expression') flow(node);
          if (!['ifStatement', 'whileStatement', 'basicForStatement'].includes(node.name)) continue;
          const condition = flow(javaChild(node, 'expression'));
          const [yes, no] = node.children.statement || [];
          if (yes) allow(condition.yes, position(yes), end(yes));
          if (no) allow(condition.no, position(no), end(no));
          const update = javaChild(node, 'forUpdate');
          if (update) allow(condition.yes, position(update), end(update));
          if (node.name !== 'ifStatement') continue;
          const following = union(exits(yes) ? condition.no : new Set(), exits(no) ? condition.yes : new Set());
          const outer = scopes.get(node).parent;
          if (outer?.node) for (const binding of following) {
            binding.ranges.push([end(node), end(outer.node)]);
            registerPattern(outer, binding);
          }
        }
        const comparisons = [];
        const infer = (node, depth = 0) => {
          if (!node || depth > 80) return 'unknown';
          if (typeCache.has(node)) return typeCache.get(node);
          typeCache.set(node, 'unknown');
          const scope = scopes.get(node) || root;
          let type = 'unknown';
          const children = Object.values(node.children || {}).flat().filter(child => child.name);
          if (node.name === 'binaryExpression' && node.children.AssignmentOperator) {
            // Java assignments have the left-hand variable's declared type.
            type = infer(javaChild(node, 'unaryExpression'), depth + 1);
          } else if (node.name === 'binaryExpression' && (node.children.BinaryOperator || node.children.Instanceof || node.children.shiftOperator)) {
            const parts = Object.values(node.children).flat().sort((a, b) => position(a) - position(b));
            const values = [];
            const ops = [];
            const reduce = () => {
              const op = ops.pop();
              const right = values.pop() || 'unknown';
              const left = values.pop() || 'unknown';
              const operator = op.image || code(op);
              if (['==', '!='].includes(operator)) comparisons.push({ op, left, right });
              values.push(operator === '+' && (left === 'string' || right === 'string') ? 'string'
                : operator === 'instanceof' || /^(?:==|!=|<=?|>=?|&&|\|\|)$/.test(operator)
                  || ['&', '|', '^'].includes(operator) && left === 'boolean' && right === 'boolean' ? 'boolean' : 'number');
            };
            for (const part of parts) {
              const operator = part.image || (part.name === 'shiftOperator' ? code(part) : '');
              if (Object.hasOwn(precedence, operator)) {
                while (ops.length && precedence[ops[ops.length - 1].image || code(ops[ops.length - 1])] >= precedence[operator]) reduce();
                ops.push(part);
              } else values.push(infer(part, depth + 1));
            }
            while (ops.length) reduce();
            type = values[0] || 'unknown';
          } else if (node.name === 'conditionalExpression' && node.children.QuestionMark) {
            const branches = node.children.expression || [];
            const types = branches.map(branch => infer(branch, depth + 1));
            type = types.length === 2 && types[0] === types[1] ? types[0] : 'unknown';
            // A null branch does not erase the other branch's reference type.
            if (types.length === 2 && types.includes('null')) {
              const reference = types.find(value => value !== 'null');
              if (reference === 'string' || reference?.endsWith('[]')) type = reference;
            }
          } else if (node.name === 'primary') {
            const prefix = javaChild(node, 'primaryPrefix');
            const suffixes = node.children.primarySuffix || [];
            // Only this primary's trailing subscripts consume array dimensions;
            // brackets inside an index or method argument belong to other nodes.
            let arrayStart = suffixes.length;
            while (arrayStart > 0 && javaChild(suffixes[arrayStart - 1], 'arrayAccessSuffix')) arrayStart--;
            const dimensions = suffixes.length - arrayStart;
            const baseEnd = dimensions ? position(suffixes[arrayStart]) : end(node);
            const parenthesis = javaChild(prefix, 'parenthesisExpression');
            const cast = javaChild(prefix, 'castExpression');
            const array = javaChild(javaChild(prefix, 'newExpression'), 'arrayCreationExpression');
            const constructed = javaChild(javaChild(prefix, 'newExpression'), 'unqualifiedClassInstanceCreationExpression');
            if (array && arrayStart === 0) {
              const suffix = javaChild(array, 'arrayCreationWithInitializerSuffix') || javaChild(array, 'arrayCreationExpressionWithoutInitializerSuffix');
              const dimensions = (javaChild(suffix, 'dimExprs')?.children.dimExpr?.length || 0)
                + (javaChild(suffix, 'dims')?.children.LSquare?.length || 0);
              type = normalizeType(typeCode(javaChild(array, 'primitiveType') || javaChild(array, 'classOrInterfaceType')), scope) + '[]'.repeat(dimensions);
            } else if (cast && arrayStart === 0) {
              const expression = javaChild(cast, 'referenceTypeCastExpression') || javaChild(cast, 'primitiveTypeCastExpression');
              type = normalizeType(typeCode(javaChild(expression, 'referenceType') || javaChild(expression, 'primitiveType')), scope);
            } else if (parenthesis && arrayStart === 0) type = infer(javaChild(parenthesis, 'expression'), depth + 1);
            else if (constructed && arrayStart === 0) type = normalizeType(typeCode(javaChild(constructed, 'classOrInterfaceTypeToInstantiate')), scope);
            else {
              const parts = tokensFor(node).filter(token => position(token) < baseEnd);
              const first = parts[0];
              const images = parts.map(token => token.image);
              const raw = images.join('');
              if (parts.length === 1 && first) {
                if (/StringLiteral|TextBlock/.test(first.tokenType.name)) type = 'string';
                else if (first.image === 'null') type = 'null';
                else if (/^(?:true|false)$/.test(first.image)) type = 'boolean';
                else if (/Literal/.test(first.tokenType.name)) type = 'number';
                else {
                  const binding = lookup(first.image, scope, position(node));
                  if (binding) type = binding.type === 'var' ? infer(binding.initializer, depth + 1) : normalizeType(binding.type, binding.scope);
                }
              } else {
                const member = raw.match(/^(?:(this|super|[\p{ID_Start}_$][\p{ID_Continue}$]*)\.)?([\p{ID_Start}_$][\p{ID_Continue}$]*)(\([^]*\)|(?:\[[^]*\])+)?$/u);
                if (member) {
                  const [, receiver, name, suffix = ''] = member;
                  let owner = classScope(scope);
                  if (receiver && receiver !== 'this') {
                    if (receiver === 'super') owner = superClass(owner);
                    else { const binding = lookup(receiver, scope, position(node)); owner = binding ? resolveType(binding.type, binding.scope) : resolveType(receiver, scope); }
                  }
                  if (suffix.startsWith('(')) {
                    // A chained call such as getText().length() no longer has
                    // getText's return type. Nested argument calls are separate CSTs.
                    if (javaChild(suffixes[arrayStart - 1], 'methodInvocationSuffix')
                        && suffixes.slice(0, arrayStart).filter(suffix => javaChild(suffix, 'methodInvocationSuffix')).length === 1) {
                      type = methodType(owner || (!receiver ? root : null), name);
                      // Unqualified calls can use a lexically enclosing class.
                      // An explicitly qualified call or a shadowing declaration cannot.
                      while (type === null && !receiver && owner) {
                        owner = classScope(owner.parent);
                        type = methodType(owner, name);
                      }
                      type ||= 'unknown';
                    }
                  }
                  else {
                    const binding = receiver ? fields(owner, name) : lookup(name, scope, position(node));
                    if (binding) {
                      const declared = binding.type;
                      type = declared === 'var' ? infer(binding.initializer, depth + 1) : normalizeType(declared, binding.scope);
                    }
                  }
                }
              }
            }
            for (let index = 0; index < dimensions; index++) type = type.endsWith('[]') ? type.slice(0, -2) : 'unknown';
          } else if (node.name === 'unaryExpression' && node.children.UnaryPrefixOperator) {
            type = node.children.UnaryPrefixOperator[0].image === '!' ? 'boolean' : 'number';
          } else if (children.length === 1) type = infer(children[0], depth + 1);
          typeCache.set(node, type);
          return type;
        };
        for (const node of entries) if (node.name === 'binaryExpression') infer(node);
        return { entries, declarations, methods, classes, scopes, parents, ancestor, text, code, typeCode, position, end, offsets, normalizeType, infer, comparisons, tokens, tokenOffsets, lookup, resolveType };
      }

      function analyzeJavaTreeQuality(lex, issues) {
        const model = lex.javaModel || (lex.javaModel = createJavaModel(lex));
        const lineOf = node => lineAtOffset(model.offsets, model.position(node));
        for (const node of model.entries) {
          const scope = model.scopes.get(node);
          if (node.name === 'catchClause') {
            const parameter = javaChild(node, 'catchFormalParameter');
            const types = (javaChild(parameter, 'catchType')?.children.unannClassType || []).map(model.typeCode);
            if (types.some(type => type === 'java.lang.Exception' || type === 'Exception' && !model.resolveType(type, scope))) {
              addIssue(issues, { level: 'info', line: lineOf(node),
                title: 'Exception を広く catch しています',
                suggestion: '必要に応じて、より具体的な例外型を扱えないか確認してください。' });
            }
            const block = javaChild(node, 'block');
            if (block && !javaChild(block, 'blockStatements')) {
              addIssue(issues, { level: 'fix', line: lineOf(node),
                title: '空の catch ブロックがあります',
                suggestion: '例外を握りつぶす意図が明確でない場合は、適切な処理・ログ・再throwを検討してください。' });
            }
          }
          if (node.name !== 'methodInvocationSuffix') continue;
          const index = lineAtOffset(model.tokenOffsets, model.position(node)) - 1;
          const name = model.tokens[index - 1];
          if (!name) continue;
          if (name.image === 'printStackTrace' && model.tokens[index - 2]?.image === '.') {
            addIssue(issues, { level: 'warn', line: lineOf(name),
              title: 'printStackTrace() が残っています',
              suggestion: '例外の扱い方やプロジェクトのログ方針に合わせて処理してください。' });
          }
          if (name.image !== 'println') continue;
          const primary = model.parents.get(model.parents.get(node));
          if (primary?.name !== 'primary') continue;
          const first = lineAtOffset(model.tokenOffsets, model.position(primary)) - 1;
          // Only a direct System.out receiver qualifies; a custom member chain
          // such as service.System.out is unrelated to java.lang.System.
          if (index - first !== 5 && index - first !== 9) continue;
          const receiver = model.tokens.slice(first, index).map(token => token.image).join('');
          const standard = receiver === 'java.lang.System.out.println'
            || receiver === 'System.out.println' && !model.resolveType('System', scope) && !model.lookup('System', scope, model.position(node));
          if (standard) addIssue(issues, { level: 'warn', line: lineOf(name),
            title: 'System.out.println が残っています',
            suggestion: 'デバッグ出力の消し忘れでないか確認してください。必要ならプロジェクトのロガーを使用します。' });
        }
      }

      function analyzeJavaTreeNaming(lex, issues) {
        const model = lex.javaModel || (lex.javaModel = createJavaModel(lex));
        for (const binding of model.declarations) {
          const line = lineAtOffset(model.offsets, binding.start);
          if (binding.constant && !isUpperSnake(binding.name)) {
            addIssue(issues, { level: 'fix', line,
              title: `Java定数「${binding.name}」は UPPER_SNAKE_CASE にしてください`, suggestion: `例: ${toUpperSnake(binding.name)}` });
          }
          const type = binding.type === 'var' ? model.infer(binding.initializer) : model.normalizeType(binding.type, binding.scope);
          checkVariableName(binding.name, type === 'boolean' ? type : '', line, lex.noComments[line - 1], issues, { constant: binding.constant });
          if (/^(?:[\w.]+\.)?(?:List|Set|Collection|ArrayList|HashSet|LinkedList|Iterable|Stream)(?:<|$)/.test(type)
              && !/(?:s|List|Set|Collection)$/.test(binding.name)) {
            addIssue(issues, { level: 'warn', line,
              title: `コレクション変数「${binding.name}」は複数形が分かる名前にしてください`, suggestion: '例: users / userList / orderIds' });
          }
        }
        for (const { id, returnType, scope } of model.methods) checkMethodName(id.image, lineAtOffset(model.offsets, model.position(id)), model.normalizeType(returnType, scope) === 'boolean' ? 'boolean' : '', '', issues);
        for (const scope of model.classes) {
          const name = scope.name;
          if (!isPascal(name)) addIssue(issues, { level: 'fix', line: lineAtOffset(model.offsets, model.position(scope.id)), title: `クラス名「${name}」は PascalCase にしてください`, suggestion: '例: UserService / OrderController' });
        }
        for (const node of model.entries) {
          if (node.name !== 'enumConstant') continue;
          const id = javaChild(node, 'Identifier');
          if (id && !isUpperSnake(id.image)) addIssue(issues, { level: 'fix', line: lineAtOffset(model.offsets, model.position(id)), title: `enum定数「${id.image}」は UPPER_SNAKE_CASE にしてください`, suggestion: `例: ${toUpperSnake(id.image)}` });
        }
        for (const { op, left, right } of model.comparisons) {
          if (left === 'null' || right === 'null' || left !== 'string' && right !== 'string') continue;
          addIssue(issues, { level: 'fix', line: lineAtOffset(model.offsets, model.position(op)),
            title: 'Stringの比較に == / != が使われています',
            message: 'Javaの == / != は文字列内容ではなく参照を比較します。',
            suggestion: 'equals / Objects.equals など、意図に合う比較を使用してください。' });
        }
      }
