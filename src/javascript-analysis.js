      function staticMemberName(node) {
        if (node.type !== 'MemberExpression') return null;
        if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
        if (node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value;
        if (node.property.type === 'TemplateLiteral' && node.property.expressions.length === 0) return node.property.quasis[0].value.cooked;
        return null;
      }

      function patternBindings(pattern, includeMembers = false) {
        const result = [];
        const pending = [{ pattern, initializer: null }];
        while (pending.length) {
          const { pattern: current, initializer } = pending.pop();
          if (!current) continue;
          if ((current.type === 'Identifier' && current.name !== '✖') || (includeMembers && current.type === 'MemberExpression')) result.push({ id: current, initializer });
          else if (current.type === 'AssignmentPattern') pending.push({ pattern: current.left, initializer: current.right });
          else if (current.type === 'RestElement') pending.push({ pattern: current.argument, initializer: null });
          else if (current.type === 'ArrayPattern') for (const element of current.elements) pending.push({ pattern: element, initializer: null });
          else if (current.type === 'ObjectPattern') for (const property of current.properties) pending.push({ pattern: property.type === 'RestElement' ? property.argument : property.value, initializer: null });
        }
        return result;
      }

      function createJavaScriptModel(parsed) {
        const scopes = new Map();
        const parents = new Map(parsed.nodes.map(({ node, parent }) => [node, parent]));
        const root = { parent: null, function: true, bindings: new Map() };
        const bindings = [];
        const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
        const bind = (id, scope, initializer, kind, parameter = false, defaultOnly = false) => {
          const binding = { id, scope, initializer, kind, parameter, defaultOnly, mutated: false };
          const previous = scope.bindings.get(id.name);
          if (previous) { previous.mutated = true; binding.mutated = true; }
          scope.bindings.set(id.name, binding);
          bindings.push(binding);
          return binding;
        };
        for (const { node, parent } of parsed.nodes) {
          let outer = parent ? scopes.get(parent) : root;
          // A switch discriminant runs before the case block's lexical scope.
          if (parent?.type === 'SwitchStatement' && parent.discriminant === node) outer = outer.parent;
          if (parent?.type === 'WithStatement' && parent.object === node) outer = outer.parent;
          const ownsScope = functionTypes.has(node.type) || ['BlockStatement', 'StaticBlock', 'SwitchStatement', 'WithStatement', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'ClassDeclaration', 'ClassExpression'].includes(node.type);
          const functionBody = node.type === 'BlockStatement' && functionTypes.has(parent?.type);
          // Body declarations cannot shadow globals used by parameter defaults.
          const scope = ownsScope ? { parent: outer, function: functionTypes.has(node.type) || node.type === 'StaticBlock' || functionBody, dynamic: node.type === 'WithStatement', bindings: new Map() } : outer;
          scopes.set(node, scope);
          if (functionTypes.has(node.type)) {
            if (node.id) bind(node.id, node.type === 'FunctionDeclaration' ? outer : scope, node, 'function');
            for (const parameter of node.params) for (const { id, initializer } of patternBindings(parameter)) bind(id, scope, initializer, 'parameter', true);
          } else if (node.type === 'CatchClause' && node.param) {
            for (const { id } of patternBindings(node.param)) bind(id, scope, null, 'parameter', true);
          } else if (node.type === 'VariableDeclarator') {
            let target = scope;
            if (parent.kind === 'var') while (target.parent && !target.function) target = target.parent;
            for (const { id, initializer } of patternBindings(node.id)) {
              // A destructuring default is only used for undefined values; the
              // actual property/element may have any type supplied by the caller.
              bind(id, target, initializer || (node.id.type === 'Identifier' ? node.init : null), parent.kind, false, Boolean(initializer));
            }
          } else if (['ClassDeclaration', 'ClassExpression'].includes(node.type) && node.id) {
            bind(node.id, node.type === 'ClassDeclaration' ? outer : scope, node, 'class');
          } else if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(node.type)) {
            bind(node.local, scope, null, 'import');
          }
        }
        const globalWrites = new Set();
        const unknownBinding = { mutated: true };
        const lookup = (name, node, potentialWrite = false) => {
          for (let scope = scopes.get(node); scope; scope = scope.parent) {
            if (scope.bindings.has(name)) return scope.bindings.get(name);
            // A with object's properties can shadow every outer identifier.
            if (scope.dynamic && !potentialWrite) return unknownBinding;
          }
          return globalWrites.has(name) ? unknownBinding : null;
        };
        const writeTargets = [];
        for (const { node } of parsed.nodes) {
          const target = ['AssignmentExpression', 'ForInStatement', 'ForOfStatement'].includes(node.type) ? node.left
            : node.type === 'UpdateExpression' || node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument : null;
          if (target) writeTargets.push(target);
          if (target) for (const { id } of patternBindings(target)) {
            // If a with object lacks this property, the assignment can still
            // reach an outer binding. Invalidate that possible target as well.
            const binding = lookup(id.name, node, true);
            // Sloppy-mode delete cannot remove a declared lexical/var binding.
            if (binding) { if (node.type !== 'UnaryExpression') binding.mutated = true; }
            else globalWrites.add(id.name);
          }
        }
        const globalObjects = new Set(['globalThis', 'window', 'self', 'global']);
        const memberWrites = new Map();
        const globalPath = node => {
          const parts = [];
          while (node?.type === 'MemberExpression') {
            const property = staticMemberName(node);
            if (property === null) return null;
            parts.unshift(property);
            if (parts.length > 2) return null;
            node = node.object;
          }
          if (node?.type !== 'Identifier' || lookup(node.name, node, true)) return null;
          if (!globalObjects.has(node.name)) parts.unshift(node.name);
          return parts;
        };
        // Resolve paths before recording any member writes so source traversal
        // order cannot hide another write to the same global object.
        const paths = writeTargets.flatMap(target => patternBindings(target, true)
          .filter(({ id }) => id.type === 'MemberExpression').map(({ id }) => globalPath(id)).filter(Boolean));
        for (const path of paths) {
          if (path.length === 1) globalWrites.add(path[0]);
          else if (path.length === 2) {
            if (!memberWrites.has(path[0])) memberWrites.set(path[0], new Set());
            memberWrites.get(path[0]).add(path[1]);
          }
        }
        const isGlobalMember = (object, name, node) => !lookup(object, node) && !memberWrites.get(object)?.has(name);
        const typeCache = new Map();
        const typeOf = (node, visited = new Set()) => {
          if (typeCache.has(node)) return typeCache.get(node);
          if (!node || visited.size > 50 || visited.has(node)) return 'unknown';
          visited.add(node);
          const type = inferType(node, visited);
          typeCache.set(node, type);
          return type;
        };
        const inferType = (node, visited) => {
          if (node.type === 'ChainExpression') return typeOf(node.expression, visited);
          if (node.type === 'Identifier') {
            const binding = lookup(node.name, node);
            return binding && !binding.mutated && !binding.parameter && !binding.defaultOnly && binding.id.start < node.start ? typeOf(binding.initializer, visited) : 'unknown';
          }
          if (node.type === 'Literal') return node.regex ? 'object' : node.value === null ? 'null' : typeof node.value;
          if (node.type === 'TemplateLiteral') return 'string';
          if (['ObjectExpression', 'ArrayExpression', 'NewExpression'].includes(node.type)) return 'object';
          if (node.type === 'UnaryExpression') return node.operator === 'typeof' ? 'string'
            : ['!', 'delete'].includes(node.operator) ? 'boolean' : node.operator === 'void' ? 'undefined' : 'number';
          // Updates can return Number or BigInt, but never a string.
          if (node.type === 'UpdateExpression') return 'numeric';
          if (node.type === 'AssignmentExpression' && node.operator === '=') return typeOf(node.right, visited);
          if (node.type === 'SequenceExpression') return typeOf(node.expressions.at(-1), visited);
          if (node.type === 'BinaryExpression' || node.type === 'AssignmentExpression' && !['&&=', '||=', '??='].includes(node.operator)) {
            if (['==', '!=', '===', '!==', '<', '>', '<=', '>=', 'instanceof', 'in'].includes(node.operator)) return 'boolean';
            if (node.operator === '+' || node.operator === '+=') {
              const types = [node.left, node.right].map(value => typeOf(value, new Set(visited)));
              if (types.includes('string')) return 'string';
              return types.every(type => ['number', 'bigint', 'numeric', 'boolean', 'null', 'undefined'].includes(type)) ? 'numeric' : 'unknown';
            }
            return 'numeric';
          }
          if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression' || node.type === 'AssignmentExpression') {
            const a = typeOf(node.consequent || node.left, new Set(visited));
            const b = typeOf(node.alternate || node.right, new Set(visited));
            return a === b ? a : [a, b].every(type => ['number', 'bigint', 'numeric'].includes(type)) ? 'numeric' : 'unknown';
          }
          if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && !lookup(node.callee.name, node)) {
            const builtins = { String: 'string', Number: 'number', Boolean: 'boolean', BigInt: 'bigint', parseInt: 'number', parseFloat: 'number' };
            return Object.hasOwn(builtins, node.callee.name) ? builtins[node.callee.name] : 'unknown';
          }
          return 'unknown';
        };
        // Prime earlier initializers first. Shared conditional branches then take
        // linear work, and long alias chains do not exhaust the recursion budget.
        const orderedBindings = bindings.slice().sort((a, b) => a.id.start - b.id.start);
        for (const binding of orderedBindings) typeOf(binding.initializer);
        const receiverCache = new Map();
        const isStringValueReceiver = (node, visited = new Set()) => {
          if (receiverCache.has(node)) return receiverCache.get(node);
          if (!node || visited.has(node) || visited.size > 30) return false;
          visited.add(node);
          const result = inferStringValueReceiver(node, visited);
          receiverCache.set(node, result);
          return result;
        };
        const inferStringValueReceiver = (node, visited) => {
          if (node.type === 'ChainExpression') return isStringValueReceiver(node.expression, visited);
          if (node.type === 'AssignmentExpression' && node.operator === '=') return isStringValueReceiver(node.right, visited);
          if (node.type === 'SequenceExpression') return isStringValueReceiver(node.expressions.at(-1), visited);
          if (node.type === 'Identifier') {
            const binding = lookup(node.name, node);
            if (binding) return !binding.mutated && !binding.parameter && !binding.defaultOnly && binding.id.start < node.start && isStringValueReceiver(binding.initializer, visited);
            // Preserve the existing convention for standalone DOM snippets.
            return /^(?:input|select|textarea|button|option)$/.test(node.name);
          }
          if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return false;
          const { object } = node.callee;
          if (object.type !== 'Identifier' || object.name !== 'document') return false;
          const method = staticMemberName(node.callee);
          if (!isGlobalMember('document', method, node)) return false;
          if (!['querySelector', 'createElement', 'getElementById'].includes(method)) return false;
          const argument = node.arguments[0];
          if (!argument || argument.type !== 'Literal' || typeof argument.value !== 'string') return false;
          // An ID can refer to progress/meter/custom elements with numeric values.
          // Only selectors whose selected element is known to have a string value qualify.
          if (method === 'getElementById') return false;
          if (method === 'createElement') return /^(?:input|select|textarea|button|option)$/i.test(argument.value);
          return /^(?:input|select|textarea|button|option)(?:[.#][\w-]+|\[[\w-]+(?:[~|^$*]?=(?:[\w-]+|'[^']*'|"[^"]*"))?\]|:[\w-]+)*$/i.test(argument.value.trim());
        };
        for (const binding of orderedBindings) isStringValueReceiver(binding.initializer);
        return { bindings, scopes, parents, lookup, typeOf, isStringValueReceiver, isGlobalMember };
      }

      function controlKeywordStarts(parsed) {
        const starts = new Set();
        const types = new Set(['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'SwitchStatement', 'CatchClause']);
        for (const { node } of parsed.nodes) {
          if (types.has(node.type)) starts.add(node.start);
          else if (node.type === 'DoWhileStatement') {
            const keyword = tokenAfter(parsed, node.body.end, 'while');
            if (keyword && keyword.end <= node.test.start) starts.add(keyword.start);
          }
        }
        return starts;
      }

      function tokenAfter(parsed, offset, label) {
        const offsets = parsed.tokenOffsets || (parsed.tokenOffsets = parsed.tokens.map(token => token.start));
        let index = offsets.length ? lineAtOffset(offsets, offset) - 1 : 0;
        while (index < parsed.tokens.length && parsed.tokens[index].start < offset) index++;
        for (; index < parsed.tokens.length; index++) {
          const token = parsed.tokens[index];
          if (!label || token.type.label === label) return token;
        }
        return null;
      }

      function comparisonToken(parsed, node) {
        const token = tokenAfter(parsed, node.left.end, '==/!=/===/!==');
        return token && token.end <= node.right.start && token.value === node.operator ? token : null;
      }
