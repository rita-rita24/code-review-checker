(() => {
      'use strict';

      const REVIEW_DELAY_MS = 300;
      const LONG_LINE_LIMIT = 120;
      const MAX_ISSUES_PER_LINE = 3;
      const AMBIGUOUS_NAMES = new Set(['data', 'info', 'value', 'item', 'obj', 'object', 'tmp', 'temp', 'result']);
      const ALLOWED_SHORT_NAMES = new Set(['i', 'j', 'k', 'x', 'y', 'e']);
      const AMBIGUOUS_METHOD_NAMES = new Set(['process', 'execute', 'doSomething', 'handle']);
      const BOOLEAN_PREFIXES = ['is', 'has', 'can', 'should', 'needs', 'contains', 'exists', 'supports'];
      const METHOD_TYPE_SUFFIXES = ['String', 'Str', 'Int', 'Bool', 'Boolean', 'Array', 'List', 'Obj', 'Object'];
      const HUNGARIAN_PREFIXES = ['str', 'int', 'bool', 'arr', 'lst', 'obj'];
      const ABBREVIATIONS = {
        usr: 'user',
        cnt: 'count',
        msg: 'message',
        cfg: 'config'
      };
      const ABBREVIATION_PATTERNS = Object.entries(ABBREVIATIONS).map(([abbr, full]) => ({
        abbr, full, pattern: new RegExp(`(^${abbr}(?=[A-Z_]|$)|_${abbr}(?=_|$))`)
      }));

      // Workers load these same embedded scripts; pasted source is only data.
      if (typeof document === 'undefined') {
        self.onmessage = event => {
          const { id, source, language } = event.data;
          try { self.postMessage({ id, result: prepareReview(source, language) }); }
          catch (_) { self.postMessage({ id, failed: true }); }
        };
        return;
      }
      const appSource = document.currentScript ? document.currentScript.textContent : '';
      const els = {
        code: document.getElementById('codeInput'),
        gutter: document.getElementById('gutterInner'),
        resultList: document.getElementById('resultList'),
        summary: document.getElementById('summary'),
        themeToggle: document.getElementById('themeToggle'),
        themeToggleIcon: document.getElementById('themeToggleIcon'),
        themeToggleLabel: document.getElementById('themeToggleLabel'),
        clearBtn: document.getElementById('clearBtn'),
        langBtns: Array.from(document.querySelectorAll('.lang-btn'))
      };

      let language = 'java';
      let reviewTimer = null;
      let lastIssues = [];
      let lastLex = null;
      let revision = 0;
      let worker = null;
      let workerURL = null;
      let workerBusy = false;
      let workerUnavailable = false;
      let isComposing = false;
      let renderedSource = '';
      let renderedLanguage = language;
      let renderFrame = null;
      let gutterState = { count: 1, levels: new Uint8Array(2), first: -1, last: -1 };

      const THEME_STORAGE_KEY = 'code-review-checker-theme';
      let themePreference = null;
      let systemTheme = null;
      try {
        const saved = localStorage.getItem(THEME_STORAGE_KEY);
        if (saved === 'dark' || saved === 'light') themePreference = saved;
      } catch (_) { /* Keep the in-memory preference when storage is unavailable. */ }
      try {
        systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
        systemTheme.addEventListener?.('change', () => {
          if (themePreference === null) setTheme(systemTheme.matches ? 'dark' : 'light', false);
        });
      } catch (_) { /* Theme buttons also work without media query support. */ }

      function getTheme() {
        return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      }

      function renderThemeToggle() {
        const isDark = getTheme() === 'dark';
        els.themeToggle.setAttribute('aria-label', isDark ? 'ライトモードに切り替え' : 'ダークモードに切り替え');
        els.themeToggle.title = els.themeToggle.getAttribute('aria-label');
        els.themeToggleIcon.querySelectorAll('[data-theme-icon]').forEach(icon => {
          icon.hidden = icon.dataset.themeIcon !== getTheme();
        });
        els.themeToggleLabel.textContent = isDark ? 'ダーク' : 'ライト';
      }

      function setTheme(theme, persist = true) {
        const nextTheme = theme === 'dark' ? 'dark' : 'light';
        document.documentElement.dataset.theme = nextTheme;
        document.documentElement.dataset.mode = nextTheme;
        renderThemeToggle();
        if (persist) {
          themePreference = nextTheme;
          try {
            localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
          } catch (_) {
            // localStorageが使えない環境でもテーマ切替自体は継続する。
          }
        }
      }

      function scheduleReview() {
        invalidateReview();
        if (isComposing) return;
        reviewTimer = setTimeout(runReview, REVIEW_DELAY_MS);
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#039;');
      }

      function levelLabel(level) {
        return level === 'fix' ? '要修正' : level === 'warn' ? '警告' : '情報';
      }

      function addIssue(issues, issue) {
        const line = Math.max(1, issue.line || 1);
        issues.push({
          level: 'warn',
          suggestion: '',
          message: '',
          endLine: line,
          ...issue,
          line,
          endLine: Math.max(line, issue.endLine || line)
        });
      }

      function isLowerCamel(name) {
        return /^[a-z][A-Za-z0-9]*$/.test(name);
      }

      function isPascal(name) {
        return /^[A-Z][A-Za-z0-9]*$/.test(name);
      }

      function isUpperSnake(name) {
        return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(name);
      }

      function startsWithBooleanPrefix(name) {
        return BOOLEAN_PREFIXES.some(prefix => name.startsWith(prefix) && name.length > prefix.length && /[A-Z]/.test(name[prefix.length]));
      }

      function toUpperSnake(name) {
        return name
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .replace(/[-\s]+/g, '_')
          .replace(/__+/g, '_')
          .toUpperCase();
      }

      function countLeadingSpaces(line) {
        const match = line.match(/^[ ]*/);
        return match ? match[0].length : 0;
      }

      function lineSnippet(lines, line) {
        const raw = lines[line - 1] || '';
        return raw.trim().slice(0, 160);
      }

      function parseJavaScript(source) {
        const options = {
          ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true
        };
        let ast = null;
        let tokens = [];
        let comments = [];
        let semicolons = [];
        // Module and classic script inputs have different reserved-word rules.
        for (const sourceType of ['module', 'script']) {
          tokens = [];
          comments = [];
          semicolons = [];
          try {
            ast = acorn.parse(source, {
              ...options, sourceType, onToken: tokens, onComment: comments,
              onInsertedSemicolon: (offset, loc) => semicolons.push({ offset, loc })
            });
            break;
          } catch (error) {
            if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) throw error;
          }
        }
        const complete = Boolean(ast);
        let unreadStart = source.length;
        if (!ast) {
          // Incomplete input is normal while typing. Only token-level rules are safe here.
          tokens = [];
          comments = [];
          semicolons = [];
          const tokenizer = acorn.tokenizer(source, { ...options, onComment: comments });
          try {
            for (;;) {
              const token = tokenizer.getToken();
              tokens.push(token);
              if (token.type.label === 'eof') break;
            }
          } catch (error) {
            if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) throw error;
            unreadStart = tokens.length ? tokens[tokens.length - 1].end : 0;
          }
        }

        if (!ast) {
          try {
            ast = reviewParsers.acornLoose.parse(source.slice(0, unreadStart), options);
          } catch (error) {
            if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) throw error;
          }
        }

        const nodes = [];
        if (ast) {
          const pending = [{ node: ast, parent: null }];
          while (pending.length) {
            const entry = pending.pop();
            nodes.push(entry);
            for (const value of Object.values(entry.node)) {
              if (Array.isArray(value)) {
                for (const child of value) {
                  if (child && typeof child.type === 'string') pending.push({ node: child, parent: entry.node });
                }
              } else if (value && typeof value.type === 'string') {
                pending.push({ node: value, parent: entry.node });
              }
            }
          }
        }
        // Acorn counts Unicode line separators as newlines; a textarea's gutter uses LF.
        // Map diagnostics to the editor without changing characters inside string literals.
        if (/[\u2028\u2029]/.test(source)) {
          const offsets = sourceLineOffsets(source.split('\n'));
          const location = offset => {
            const line = lineAtOffset(offsets, offset);
            return { line, column: offset - offsets[line - 1] };
          };
          for (const entry of [...tokens, ...comments, ...nodes.map(({ node }) => node)]) {
            entry.loc = { start: location(entry.start), end: location(entry.end) };
          }
          for (const entry of semicolons) entry.loc = location(entry.offset);
        }
        const topLevelDeclarations = new Set(nodes.filter(({ node, parent }) =>
          node.type === 'VariableDeclaration' && (parent.type === 'Program' || parent.type === 'ExportNamedDeclaration')
        ).map(({ node }) => node));
        return { ast, complete, tokens, comments, semicolons, nodes, unreadStart, topLevelDeclarations };
      }

      function maskSource(source, ranges) {
        const parts = [];
        let offset = 0;
        for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
          const start = Math.max(offset, range.start);
          if (range.end <= start) continue;
          parts.push(source.slice(offset, start), source.slice(start, range.end).replace(/[^\n\r\t]/g, ' '));
          offset = range.end;
        }
        parts.push(source.slice(offset));
        return parts.join('');
      }

      function lexJavaScript(source) {
        const parsed = parseJavaScript(source);
        const lines = source.split('\n');
        const stringsByLine = lines.map(() => []);
        const masked = [...parsed.comments];
        const templateDepths = [];
        for (const token of parsed.tokens) {
          const label = token.type.label;
          if (['string', 'regexp', 'template', 'invalidTemplate', '`', '${'].includes(label)) {
            masked.push(token);
          }
          if (label === 'string') {
            stringsByLine[token.loc.start.line - 1].push({
              start: token.loc.start.column,
              end: token.loc.end.line === token.loc.start.line ? token.loc.end.column : lines[token.loc.start.line - 1].length,
              quote: source[token.start], text: source.slice(token.start, token.end)
            });
          }
          if (label === '${') templateDepths.push(0);
          else if (label === '{' && templateDepths.length) templateDepths[templateDepths.length - 1]++;
          else if (label === '}' && templateDepths.length) {
            if (templateDepths[templateDepths.length - 1] === 0) {
              templateDepths.pop();
              masked.push(token);
            } else templateDepths[templateDepths.length - 1]--;
          }
        }
        if (parsed.unreadStart < source.length) masked.push({ start: parsed.unreadStart, end: source.length });
        return {
          source, lines, stringsByLine, parsed, complete: parsed.complete,
          noComments: maskSource(source, [...parsed.comments]).split('\n'),
          structural: maskSource(source, masked).split('\n'),
          comments: parsed.comments.map(comment => ({
            type: comment.type === 'Line' ? 'line' : 'block',
            startLine: comment.loc.start.line, endLine: comment.loc.end.line,
            startCol: comment.loc.start.column, text: source.slice(comment.start, comment.end)
          }))
        };
      }

      // EMBED JAVASCRIPT ANALYSIS

      // EMBED JAVA ANALYSIS

      function lexSource(source, lang) {
        source = source.replace(/\r\n?/g, '\n');
        if (lang === 'javascript') return lexJavaScript(source);
        const lines = source.split('\n');
        const noComments = [];
        const structural = [];
        const stringsByLine = lines.map(() => []);
        const comments = [];

        let state = 'code';
        let blockCommentStartLine = -1;
        let blockCommentText = '';
        let stringQuote = '';
        let stringStartLine = -1;
        let textBlock = false;
        let activeToken = null;

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          const line = lines[lineIndex];
          let nc = '';
          let st = '';
          let i = 0;
          let lineCommentText = '';
          let lineCommentStart = -1;
          if (state === 'string') {
            activeToken = { start: 0, end: null, quote: textBlock ? '"""' : stringQuote, text: '', open: true, startLine: stringStartLine };
            stringsByLine[lineIndex].push(activeToken);
          }

          while (i < line.length) {
            const ch = line[i];
            const next = line[i + 1] || '';
            const triple = line.slice(i, i + 3);

            if (state === 'blockComment') {
              if (ch === '*' && next === '/') {
                blockCommentText += '*/';
                nc += '  ';
                st += '  ';
                i += 2;
                state = 'code';
                comments.push({
                  type: 'block',
                  startLine: blockCommentStartLine + 1,
                  endLine: lineIndex + 1,
                  text: blockCommentText
                });
                blockCommentText = '';
                blockCommentStartLine = -1;
              } else {
                blockCommentText += ch;
                nc += ch === '\t' ? '\t' : ' ';
                st += ch === '\t' ? '\t' : ' ';
                i++;
              }
              continue;
            }

            if (state === 'string') {
              const token = activeToken;

              if (textBlock) {
                if (ch === '\\') {
                  const escaped = line.slice(i, i + 2);
                  nc += escaped;
                  st += ' '.repeat(escaped.length);
                  if (token) token.text += escaped;
                  i += escaped.length;
                  continue;
                }
                if (triple === '"""') {
                  nc += '"""';
                  st += '   ';
                  if (token) { token.end = i + 3; token.text += '"""'; token.open = false; }
                  i += 3;
                  state = 'code';
                  textBlock = false;
                  stringQuote = '';
                } else {
                  nc += ch;
                  st += ch === '\t' ? '\t' : ' ';
                  if (token) token.text += ch;
                  i++;
                }
                continue;
              }

              if (ch === '\\') {
                nc += ch;
                st += ' ';
                if (token) token.text += ch;
                if (i + 1 < line.length) {
                  nc += line[i + 1];
                  st += line[i + 1] === '\t' ? '\t' : ' ';
                  if (token) token.text += line[i + 1];
                  i += 2;
                } else {
                  i++;
                }
                continue;
              }

              if (ch === stringQuote) {
                nc += ch;
                st += ' ';
                if (token) { token.end = i + 1; token.text += ch; token.open = false; }
                i++;
                state = 'code';
                stringQuote = '';
                continue;
              }

              nc += ch;
              st += ch === '\t' ? '\t' : ' ';
              if (token) token.text += ch;
              i++;
              continue;
            }

            if (ch === '/' && next === '/') {
              lineCommentStart = i;
              lineCommentText = line.slice(i);
              nc += ' '.repeat(line.length - i);
              st += ' '.repeat(line.length - i);
              i = line.length;
              break;
            }

            if (ch === '/' && next === '*') {
              state = 'blockComment';
              blockCommentStartLine = lineIndex;
              blockCommentText = '/*';
              nc += '  ';
              st += '  ';
              i += 2;
              continue;
            }

            if (lang === 'java' && triple === '"""') {
              state = 'string';
              stringQuote = '"';
              textBlock = true;
              stringStartLine = lineIndex;
              activeToken = { start: i, end: null, quote: '"""', text: '"""', open: true, startLine: stringStartLine };
              stringsByLine[lineIndex].push(activeToken);
              nc += '"""';
              st += '   ';
              i += 3;
              continue;
            }

            const isStringStart = lang === 'javascript'
              ? ch === "'" || ch === '"' || ch === '`'
              : ch === "'" || ch === '"';

            if (isStringStart) {
              state = 'string';
              stringQuote = ch;
              stringStartLine = lineIndex;
              activeToken = { start: i, end: null, quote: ch, text: ch, open: true, startLine: stringStartLine };
              stringsByLine[lineIndex].push(activeToken);
              nc += ch;
              st += ' ';
              i++;
              continue;
            }

            nc += ch;
            st += ch;
            i++;
          }

          if (lineCommentStart >= 0) {
            comments.push({ type: 'line', startLine: lineIndex + 1, endLine: lineIndex + 1, text: lineCommentText, startCol: lineCommentStart });
          }

          if (state === 'blockComment') blockCommentText += '\n';

          if (state === 'string' && !textBlock && stringQuote !== '`') {
            const token = activeToken;
            if (token) { token.end = line.length; token.open = false; }
            state = 'code';
            stringQuote = '';
          } else if (state === 'string' && stringQuote === '`') {
            const token = activeToken;
            if (token) { token.end = line.length; token.open = false; }
          }

          noComments.push(nc);
          structural.push(st);
        }

        if (state === 'blockComment' && blockCommentStartLine >= 0) {
          comments.push({
            type: 'block',
            startLine: blockCommentStartLine + 1,
            endLine: lines.length,
            text: blockCommentText
          });
        }

        const java = source.trim() ? reviewParsers.parseJava(source) : null;
        return { source, lines, noComments, structural, stringsByLine, comments, java, complete: !source.trim() || Boolean(java) };
      }

      function groupLineComments(comments) {
        const grouped = [];
        const sorted = comments.slice().sort((a, b) => a.startLine - b.startLine);
        for (const comment of sorted) {
          if (comment.type !== 'line') {
            grouped.push(comment);
            continue;
          }
          const last = grouped[grouped.length - 1];
          if (last && last.type === 'line-group' && last.endLine + 1 === comment.startLine) {
            last.endLine = comment.endLine;
            last.text += '\n' + comment.text;
          } else {
            grouped.push({ type: 'line-group', startLine: comment.startLine, endLine: comment.endLine, text: comment.text });
          }
        }
        return grouped;
      }

      function looksLikeCommentedCode(text, lang) {
        const clean = text
          .replace(/^\/\*+/, '')
          .replace(/\*+\/$/, '')
          .split('\n')
          .map(line => line.replace(/^\s*\/\/\s?/, '').replace(/^\s*\*\s?/, '').trim())
          .filter(line => !/^(?:@\w+|\w+\s*[:：])/.test(line))
          .join('\n')
          .trim();

        if (!clean || /^@\w+/.test(clean) || /^\w+\s*[:：]/.test(clean)) return false;
        if (lang === 'java' && /^(?:@param|@return|@throws|@see|@since|@author)\b/m.test(clean)) return false;

        const commonPatterns = [
          /\b(?:if|for|while|switch|catch)\s*\(|\b(?:try|else|finally|do)\s*\{|\b(?:return|throw)\b[^;\n]{0,256};|\b(?:class|function)\s+[A-Za-z_$][\w$]*\s*[{(]/,
          /\b[A-Za-z_$][\w$]*\s*=\s*[^=]/,
          /\b[A-Za-z_$][\w$]*\s*\([^()\n]{0,256}\)\s*;?/,
          /[;{}]/
        ];
        const javaPatterns = [/\b(?:String|boolean|int|long|double|List|Set|Map)(?:<[^>\n]{1,256}>)?\s+[A-Za-z_$][\w$]*\s*[=;]/];
        const jsPatterns = [/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*[=;]/, /=>/];
        const patterns = commonPatterns.concat(lang === 'java' ? javaPatterns : jsPatterns);
        return patterns.some(pattern => pattern.test(clean));
      }

      function analyzeComments(lex, lang, issues) {
        const grouped = groupLineComments(lex.comments);
        for (const comment of grouped) {
          const text = comment.text || '';
          if (/\b(?:TODO|FIXME)\b/i.test(text)) {
            addIssue(issues, {
              level: 'info', line: comment.startLine, endLine: comment.endLine,
              title: 'TODO / FIXME コメントがあります',
              message: '未完了の作業や暫定対応が残っていないか確認してください。',
              suggestion: '不要なら削除し、必要ならチケットや対応方針と紐づけると追跡しやすくなります。'
            });
          }
          if (looksLikeCommentedCode(text, lang)) {
            addIssue(issues, {
              level: 'info', line: comment.startLine, endLine: comment.endLine,
              title: 'コメントアウトされたコードの可能性があります',
              message: 'コメント内のコードは通常ルールではチェックしていません。',
              suggestion: '不要なコードなら削除し、履歴はバージョン管理に任せるのがおすすめです。'
            });
          }
        }
      }

      function analyzeCommon(lex, lang, issues) {
        const { lines, noComments, structural } = lex;

        lines.forEach((line, index) => {
          if (line.replace(/\t/g, '  ').length > LONG_LINE_LIMIT) {
            addIssue(issues, {
              level: 'info', line: index + 1,
              title: `1行が${LONG_LINE_LIMIT}文字を超えています`,
              message: '横スクロールやレビュー時の読みづらさにつながります。',
              suggestion: '式や引数を適切な位置で改行してください。'
            });
          }
        });

        // Parsed declarations cover multiline, nested and same-line class names.
        if (lang === 'java' && !lex.java) structural.forEach((line, index) => {
          const match = line.match(/\bclass\s+([A-Za-z_$][\w$]*)/);
          if (match && !isPascal(match[1])) {
            addIssue(issues, {
              level: 'fix', line: index + 1,
              title: `クラス名「${match[1]}」は PascalCase にしてください`,
              suggestion: '例: UserService / OrderController'
            });
          }
        });

        // Generic deep nesting by brace depth.
        let depth = 0;
        let deepReportedAt = -1;
        structural.forEach((line, index) => {
          const trimmed = line.trimStart();
          const closesFirst = trimmed.startsWith('}') ? 1 : 0;
          const effectiveDepth = Math.max(0, depth - closesFirst);
          if (trimmed && effectiveDepth >= 4 && deepReportedAt !== effectiveDepth) {
            addIssue(issues, {
              level: 'info', line: index + 1,
              title: 'ネストが深くなっています',
              message: `現在のブロック深度はおよそ ${effectiveDepth} 階層です。`,
              suggestion: '早期return、処理の分割、条件式の整理を検討してください。'
            });
            deepReportedAt = effectiveDepth;
          }
          for (const ch of line) {
            if (ch === '{') depth++;
            if (ch === '}') depth = Math.max(0, depth - 1);
          }
          if (depth < 4) deepReportedAt = -1;
        });

        if (lang === 'java') analyzeJavaNaming(lex, issues);
        else analyzeJavaScriptNaming(lex, issues);
      }

      function checkVariableName(name, type, line, context, issues, options = {}) {
        if (!name || name === '✖' || options.constant) return;

        if (AMBIGUOUS_NAMES.has(name)) {
          addIssue(issues, {
            level: 'info', line,
            title: `変数名「${name}」は意味が広すぎます`,
            message: '変数名だけで中身や役割が分かる名前を検討してください。',
            suggestion: '例: userProfile / activeUsers / validationResult'
          });
        }

        if (/flag$/i.test(name) || name.toLowerCase() === 'flag') {
          addIssue(issues, {
            level: 'warn', line,
            title: `「${name}」では true / false の意味が分かりにくいです`,
            suggestion: 'is / has / can / should など、状態を質問として読める名前を使ってください。'
          });
        }

        if (name.length === 1 && !ALLOWED_SHORT_NAMES.has(name)) {
          addIssue(issues, {
            level: 'warn', line,
            title: `1文字の変数名「${name}」は避けてください`,
            suggestion: '役割が分かる具体的な名前にしてください。'
          });
        }

        if (name.length === 1 && ALLOWED_SHORT_NAMES.has(name)) {
          const allowedContext = /\bfor\s*\(|=>|\bcatch\s*\(/.test(context);
          if (!allowedContext) {
            addIssue(issues, {
              level: 'info', line,
              title: `短い変数名「${name}」を確認してください`,
              message: 'ループ変数や短いコールバック以外では、具体名の方が読みやすくなります。'
            });
          }
        }

        if (!isLowerCamel(name) && name.length > 1 && !/^_/.test(name)) {
          addIssue(issues, {
            level: 'warn', line,
            title: `変数名「${name}」は lowerCamelCase にしてください`,
            suggestion: '例: userName / retryCount / activeUsers'
          });
        }

        for (const prefix of HUNGARIAN_PREFIXES) {
          if (name.startsWith(prefix) && /[A-Z]/.test(name[prefix.length] || '')) {
            addIssue(issues, {
              level: 'info', line,
              title: `型を表す接頭辞「${prefix}」は変数名に不要です`,
              suggestion: '型ではなく、値の意味や役割を名前にしてください。'
            });
            break;
          }
        }

        for (const { abbr, full, pattern } of ABBREVIATION_PATTERNS) {
          if (pattern.test(name)) {
            addIssue(issues, {
              level: 'info', line,
              title: `略語「${abbr}」を避けてください`,
              suggestion: `「${full}」のように意味が分かる単語を使ってください。`
            });
            break;
          }
        }

        const booleanType = /^(?:boolean|Boolean)$/i.test(type || '');
        const booleanInitializer = /\b(?:true|false)\b|===|!==|==|!=|\binstanceof\b/.test(options.initializer || '');
        if ((booleanType || booleanInitializer) && !startsWithBooleanPrefix(name)) {
          addIssue(issues, {
            level: 'warn', line,
            title: `Boolean変数「${name}」は状態が分かる名前にしてください`,
            suggestion: '例: isActive / hasPermission / canEdit / shouldRetry'
          });
        }

        if (/^(?:isNot|hasNo|cannot|cant|shouldNot)[A-Z]/.test(name)) {
          addIssue(issues, {
            level: 'info', line,
            title: `否定形のBoolean名「${name}」は読み間違いに注意してください`,
            suggestion: '肯定形の状態名に置き換えられないか検討してください。'
          });
        }
      }

      function checkMethodName(name, line, returnType, previousLine, issues) {
        if (!name || name === '✖') return;
        if (!isLowerCamel(name)) {
          addIssue(issues, {
            level: 'fix', line,
            title: `メソッド名「${name}」は lowerCamelCase にしてください`,
            suggestion: '例: getUser / saveOrder / calculateTotal'
          });
        }

        if (AMBIGUOUS_METHOD_NAMES.has(name)) {
          addIssue(issues, {
            level: 'info', line,
            title: `メソッド名「${name}」は処理内容が伝わりにくい可能性があります`,
            suggestion: '何を処理するのかまで名前に含めてください。例: processOrder / handleLoginError'
          });
        }

        if (/^(?:boolean|Boolean)$/i.test(returnType || '') && !startsWithBooleanPrefix(name)) {
          addIssue(issues, {
            level: 'warn', line,
            title: `Booleanを返すメソッド「${name}」の名前を確認してください`,
            suggestion: 'is / has / can / should などから始めると意図が明確です。'
          });
        }

        const suffix = METHOD_TYPE_SUFFIXES.find(value => name.endsWith(value));
        if (suffix) {
          addIssue(issues, {
            level: 'info', line,
            title: `メソッド名に型情報「${suffix}」が含まれています`,
            suggestion: '型ではなく、返す値や処理の意味を名前にしてください。'
          });
        }
      }

      function analyzeJavaNaming(lex, issues) {
        if (lex.java) { analyzeJavaTreeNaming(lex, issues); return; }
        const { structural, noComments } = lex;
        let enumDepth = null;
        let depth = 0;

        structural.forEach((line, index) => {
          const original = noComments[index];
          const lineNo = index + 1;
          const prev = index > 0 ? structural[index - 1] : '';

          // Recovery rules accept simple generic types. Do not repeatedly scan
          // unmatched nested '<' prefixes after the full parser has given up.
          const constantMatch = line.match(/\b(?:static\s+final|final\s+static)\s+[A-Za-z_$][\w$.]*(?:\s*<[^;={}<>]+>)?(?:\s*\[\s*\])*\s+([A-Za-z_$][\w$]*)\s*(?:=|;)/);
          if (constantMatch && !isUpperSnake(constantMatch[1])) {
            addIssue(issues, {
              level: 'fix', line: lineNo,
              title: `Java定数「${constantMatch[1]}」は UPPER_SNAKE_CASE にしてください`,
              suggestion: `例: ${toUpperSnake(constantMatch[1])}`
            });
          }

          const methodLine = line.trim().replace(/^(?:@[\w$.]+(?:\([^()\n]*\))?\s*)+/, '');
          const methodMatch = methodLine.match(/^(?:(?:public|protected|private|static|final|synchronized|abstract|native|default)\s+)*(?:<[^{}();<>]+>\s*)?([A-Za-z_$][\w$.]*(?:\s*<[^(){};=<>]+>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[^\{;]+)?\{/);
          if (methodMatch && !/\b(?:if|for|while|switch|catch)\s*$/.test(methodMatch[1])) {
            const returnType = methodMatch[1].trim().split(/\s+/).pop();
            const name = methodMatch[2];
            // A same-named method may have a return type. Only reject modifiers
            // captured as a constructor's apparent return type during recovery.
            if (!/^(?:public|protected|private|static|final|synchronized|abstract|native|default)$/.test(returnType)) checkMethodName(name, lineNo, returnType, prev, issues);
          }

          const declaration = line.match(/\b([A-Za-z_$][\w$]*(?:\s*<[^;=<>]+>)?(?:\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*([^;]+))?;/);
          if (declaration && !/^(?:return|new|throw|case|break|continue|yield)$/.test(declaration[1]) && !/\b(?:return|new|throw|case)\b/.test(line.slice(0, declaration.index))) {
            const type = declaration[1].replace(/\s+/g, ' ').trim();
            const name = declaration[2];
            const initializer = declaration[3] || '';
            const isConstant = Boolean(constantMatch);
            checkVariableName(name, type, lineNo, original, issues, { initializer, constant: isConstant });

            if (/^(?:List|Set|Collection|ArrayList|HashSet|LinkedList|Iterable|Stream)\b/.test(type) && !/(?:s|List|Set|Collection)$/.test(name)) {
              addIssue(issues, {
                level: 'warn', line: lineNo,
                title: `コレクション変数「${name}」は複数形が分かる名前にしてください`,
                suggestion: '例: users / userList / orderIds'
              });
            }
          }

          const enumStart = line.match(/\benum\s+[A-Za-z_$][\w$]*\s*\{/);
          if (enumStart) enumDepth = depth + 1;
          if (enumDepth != null && depth >= enumDepth) {
            const enumValue = line.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:\([^)]*\))?\s*[,;]?\s*$/);
            if (enumValue && !isUpperSnake(enumValue[1])) {
              addIssue(issues, {
                level: 'fix', line: lineNo,
                title: `enum定数「${enumValue[1]}」は UPPER_SNAKE_CASE にしてください`,
                suggestion: `例: ${toUpperSnake(enumValue[1])}`
              });
            }
          }

          for (const ch of line) {
            if (ch === '{') depth++;
            if (ch === '}') depth = Math.max(0, depth - 1);
          }
          if (enumDepth != null && depth < enumDepth) enumDepth = null;
        });

        analyzeJavaStringComparisons(lex, issues);
      }

      function sourceLineOffsets(lines) {
        const offsets = [0];
        for (let index = 0; index < lines.length - 1; index++) offsets.push(offsets[index] + lines[index].length + 1);
        return offsets;
      }

      function lineAtOffset(offsets, offset) {
        let low = 0;
        let high = offsets.length;
        while (low + 1 < high) {
          const middle = (low + high) >>> 1;
          if (offsets[middle] <= offset) low = middle;
          else high = middle;
        }
        return low + 1;
      }

      function analyzeJavaStringComparisons(lex, issues) {
        const code = lex.structural.join('\n');
        const offsets = sourceLineOffsets(lex.lines);
        const root = { parent: null, bindings: new Map() };
        let scope = root;
        const events = [{ offset: 0, scope }];
        const opened = new Map();
        for (let index = 0; index < code.length; index++) {
          if (code[index] === '{') {
            scope = { parent: scope, bindings: new Map() };
            opened.set(index, scope);
            events.push({ offset: index + 1, scope });
          } else if (code[index] === '}') {
            scope = scope.parent || root;
            events.push({ offset: index + 1, scope });
          }
        }
        const eventOffsets = events.map(event => event.offset);
        const scopeAt = offset => events[lineAtOffset(eventOffsets, offset) - 1].scope;
        const declarations = /\b([A-Za-z_$][\w$]*(?:\s*<[^;={}()<>]+>)?(?:\s*\[\s*\])?)\s+([A-Za-z_$][\w$]*)(\s*\[\s*\])?\s*(?=[=;,)])/g;
        let match;
        while ((match = declarations.exec(code)) !== null) {
          if (/^(?:return|throw|new|case|break|continue|yield)$/.test(match[1])) continue;
          let target = scopeAt(match.index);
          // Parameters belong to the following method/catch body, not its enclosing class.
          const lineStart = code.lastIndexOf('\n', match.index) + 1;
          const before = code.slice(lineStart, match.index);
          if (before.lastIndexOf('(') > before.lastIndexOf(')')) {
            const brace = code.indexOf('{', declarations.lastIndex);
            const semicolon = code.indexOf(';', declarations.lastIndex);
            if (brace >= 0 && (semicolon < 0 || brace < semicolon)) target = opened.get(brace) || target;
          }
          const name = match[2];
          const entries = target.bindings.get(name) || [];
          entries.push({ start: match.index, isString: match[1] === 'String' && !match[3] });
          target.bindings.set(name, entries);
        }
        const isStringAt = (name, offset) => {
          for (let current = scopeAt(offset); current; current = current.parent) {
            const bindings = current.bindings.get(name);
            if (!bindings) continue;
            const binding = bindings.findLast(entry => entry.start <= offset);
            if (binding) return binding.isString;
          }
          return false;
        };
        lex.noComments.forEach((line, index) => {
          const comparison = /("(?:\\.|[^"\\])*"|\b[A-Za-z_$][\w$]*)\s*(==|!=)\s*("(?:\\.|[^"\\])*"|[A-Za-z_$][\w$]*)/g;
          let match;
          while ((match = comparison.exec(line)) !== null) {
            const operatorCol = match.index + match[0].lastIndexOf(match[2], match[0].length - match[3].length - 1);
            if (lex.structural[index].slice(operatorCol, operatorCol + 2) !== match[2]) continue;
            const left = match[1];
            const right = match[3];
            if (left === 'null' || right === 'null') continue;
            const offset = offsets[index] + operatorCol;
            // Only unqualified variables can be resolved without a Java type checker.
            const leftIsLocal = !/[.\w$]$/.test(line.slice(0, match.index));
            const rightIsLocal = !/^\s*[.(\[]/.test(line.slice(comparison.lastIndex));
            if (left.startsWith('"') || right.startsWith('"')
                || leftIsLocal && isStringAt(left, offset) || rightIsLocal && isStringAt(right, offset)) {
              addIssue(issues, {
                level: 'fix', line: index + 1,
                title: 'Stringの比較に == / != が使われています',
                message: 'Javaの == / != は文字列内容ではなく参照を比較します。',
                suggestion: 'equals / Objects.equals など、意図に合う比較を使用してください。'
              });
              break;
            }
          }
        });
      }

      function analyzeJava(lex, issues) {
        if (lex.java) { analyzeJavaTreeQuality(lex, issues); return; }
        const { structural, noComments } = lex;

        structural.forEach((line, index) => {
          const lineNo = index + 1;
          if (/\bSystem\.out\.println\s*\(/.test(line)) {
            addIssue(issues, {
              level: 'warn', line: lineNo,
              title: 'System.out.println が残っています',
              suggestion: 'デバッグ出力の消し忘れでないか確認してください。必要ならプロジェクトのロガーを使用します。'
            });
          }
          if (/\.printStackTrace\s*\(/.test(line)) {
            addIssue(issues, {
              level: 'warn', line: lineNo,
              title: 'printStackTrace() が残っています',
              suggestion: '例外の扱い方やプロジェクトのログ方針に合わせて処理してください。'
            });
          }
          if (/\bcatch\s*\(\s*Exception\b/.test(line)) {
            addIssue(issues, {
              level: 'info', line: lineNo,
              title: 'Exception を広く catch しています',
              suggestion: '必要に応じて、より具体的な例外型を扱えないか確認してください。'
            });
          }
        });

        const joined = structural.join('\n');
        const offsets = sourceLineOffsets(lex.lines);
        const emptyCatchRegex = /catch\s*\([^)]*\)\s*\{\s*\}/g;
        let match;
        while ((match = emptyCatchRegex.exec(joined)) !== null) {
          const line = lineAtOffset(offsets, match.index);
          addIssue(issues, {
            level: 'fix', line,
            title: '空の catch ブロックがあります',
            suggestion: '例外を握りつぶす意図が明確でない場合は、適切な処理・ログ・再throwを検討してください。'
          });
        }
      }

      function analyzeJavaScriptNaming(lex, issues) {
        if (!lex.parsed.ast) return;
        const model = lex.jsModel || (lex.jsModel = createJavaScriptModel(lex.parsed));
        for (const binding of model.bindings) {
          const parent = model.parents.get(binding.id);
          if (['class', 'function', 'import'].includes(binding.kind) || parent && parent.type === 'VariableDeclarator' && parent.id === binding.id) continue;
          const line = binding.id.loc.start.line;
          const context = binding.parameter ? '=>' : lex.noComments[line - 1];
          checkVariableName(binding.id.name, '', line, context, issues, { initializer: !binding.defaultOnly && !binding.parameter && model.typeOf(binding.initializer) === 'boolean' ? 'true' : '' });
        }
        for (const { node, parent } of lex.parsed.nodes) {
          const line = node.loc.start.line;
          if (['ClassDeclaration', 'ClassExpression'].includes(node.type) && node.id && node.id.name !== '✖' && !isPascal(node.id.name)) {
            addIssue(issues, {
              level: 'fix', line: node.id.loc.start.line,
              title: `クラス名「${node.id.name}」は PascalCase にしてください`,
              suggestion: '例: UserService / OrderController'
            });
          }
          if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
            const name = node.id.name;
            const initializer = node.init;
            const booleanValue = model.typeOf(initializer) === 'boolean' || initializer && (
              initializer.type === 'Literal' && typeof initializer.value === 'boolean'
              || initializer.type === 'BinaryExpression' && ['==', '!=', '===', '!==', '<', '>', '<=', '>=', 'in', 'instanceof'].includes(initializer.operator)
              || initializer.type === 'UnaryExpression' && initializer.operator === '!'
            );
            const isConst = parent.kind === 'const';
            const topLevel = lex.parsed.topLevelDeclarations.has(parent);
            const primitive = initializer && initializer.type === 'Literal' && !initializer.regex;
            const constantCandidate = isConst && topLevel && primitive
              && /(?:max|min|default|limit|timeout|interval|duration|retry|size|count|version|prefix|suffix)/i.test(name);
            checkVariableName(name, '', line, lex.noComments[line - 1], issues, {
              initializer: booleanValue ? 'true' : '', constant: constantCandidate || isConst && isUpperSnake(name)
            });
            if (constantCandidate && !isUpperSnake(name)) {
              addIssue(issues, {
                level: 'info', line,
                title: `トップレベル定数候補「${name}」の命名を確認してください`,
                suggestion: `定数として扱う値なら ${toUpperSnake(name)} のような UPPER_SNAKE_CASE を検討してください。`
              });
            }
            if (initializer && initializer.type === 'ArrayExpression' && !/(?:s|List|Array)$/.test(name)) {
              addIssue(issues, {
                level: 'info', line,
                title: `配列変数「${name}」は複数であることが分かる名前を検討してください`,
                suggestion: '例: users / items / userIds'
              });
            }
            if (initializer && ['FunctionExpression', 'ArrowFunctionExpression'].includes(initializer.type)) {
              checkMethodName(name, line, '', '', issues);
            }
          }
          if (node.type === 'FunctionDeclaration' && node.id) checkMethodName(node.id.name, node.id.loc.start.line, '', '', issues);
          if ((node.type === 'MethodDefinition' || node.type === 'Property' && node.method)
              && !node.computed && node.key.type === 'Identifier') {
            checkMethodName(node.key.name, line, '', '', issues);
          }
        }
      }

      function analyzeJsQuotes(lex, issues) {
        lex.stringsByLine.forEach((tokens, index) => {
          for (const token of tokens) {
            if (token.quote === '"') {
              addIssue(issues, {
                level: 'warn', line: index + 1,
                title: '文字列はシングルクォートを使用してください',
                message: 'ダブルクォートの文字列が使われています。',
                suggestion: "例: 'text'"
              });
            }
          }
        });
      }

      function analyzeJsEquality(lex, issues) {
        for (const { node } of lex.parsed.nodes) {
          if (node.type !== 'BinaryExpression' || !['==', '!='].includes(node.operator) || node.left.start === node.left.end || node.right.start === node.right.end) continue;
          if ([node.left, node.right].some(operand => operand.type === 'Literal' && operand.value === null)) continue;
          addIssue(issues, {
            level: 'fix', line: (comparisonToken(lex.parsed, node) || node).loc.start.line,
            title: `${node.operator} ではなく ${node.operator === '==' ? '===' : '!=='} を使用してください`,
            message: '== null / != null は例外として許可しています。'
          });
        }
      }

      function analyzeJsValueComparison(lex, issues) {
        const unwrap = node => node.type === 'ChainExpression' ? node.expression : node;
        const isValue = node => staticMemberName(node) === 'value';
        const definitelyNonString = node => ['number', 'numeric', 'boolean', 'bigint', 'null', 'object'].includes(model.typeOf(node));
        const model = lex.jsModel || (lex.jsModel = createJavaScriptModel(lex.parsed));
        for (const { node } of lex.parsed.nodes) {
          if (node.type !== 'BinaryExpression' || !['===', '!=='].includes(node.operator)) continue;
          const left = unwrap(node.left);
          const right = unwrap(node.right);
          if (!(isValue(left) && model.isStringValueReceiver(left.object) && definitelyNonString(right) || isValue(right) && model.isStringValueReceiver(right.object) && definitelyNonString(left))) continue;
          addIssue(issues, {
            level: 'fix', line: (comparisonToken(lex.parsed, node) || node).loc.start.line,
            title: '.value の比較相手はシングルクォート文字列にしてください',
            suggestion: "例: input.value === '1' / '1' !== select.value"
          });
        }
      }

      function analyzeJsSpacing(lex, issues) {
        const keywordStarts = controlKeywordStarts(lex.parsed);
        for (let index = 0; index < lex.parsed.tokens.length; index++) {
          const token = lex.parsed.tokens[index];
          const next = lex.parsed.tokens[index + 1];
          if (!keywordStarts.has(token.start) || !next || next.type.label !== '(') continue;
          // Comments between a keyword and '(' are meaningful source, not spacing.
          if (/\/\*|\/\//.test(lex.source.slice(token.end, next.start))) continue;
          if (lex.source.slice(token.end, next.start) !== ' ') {
            const keyword = token.type.label;
            addIssue(issues, {
              level: 'fix', line: token.loc.start.line,
              title: `${keyword} の後ろは半角スペース1個にしてください`,
              suggestion: `例: ${keyword} (...)`
            });
          }
        }
        for (const { node } of lex.parsed.nodes) {
          // A block opener needs spacing. Object literals, patterns and imports do not.
          if (!['BlockStatement', 'ClassBody', 'SwitchStatement'].includes(node.type)) continue;
          const opening = node.type === 'SwitchStatement' ? tokenAfter(lex.parsed, node.discriminant.end, '{') : node;
          if (!opening || opening.start >= node.end || lex.source[opening.start] !== '{') continue;
          const offset = opening.start;
          const line = opening.loc.start.line;
          const before = lex.source.slice(lex.source.lastIndexOf('\n', offset - 1) + 1, offset);
          if (before.trim() && !/\S $/.test(before)) {
            addIssue(issues, {
              level: 'fix', line,
              title: '{ の前は半角スペース1個にしてください',
              suggestion: '例: if (condition) { / function run() {'
            });
          }
        }
      }

      function lineLooksLikeContinuation(line, previous) {
        const current = line.trim();
        const prev = (previous || '').trim();
        return /^(?:\.|\)|\]|&&|\|\||\?|:)/.test(current)
          || /(?:\(|\[|,|\.|\+|-|\*|\/|&&|\|\||\?|:|=|=>)$/.test(prev);
      }

      function analyzeJsIndentation(lex, issues) {
        if (!lex.complete) return;
        const offsets = sourceLineOffsets(lex.lines);
        const switchOpenings = new Set();
        const unbraced = new Int32Array(lex.lines.length + 2);
        const literalLines = new Set(lex.parsed.tokens.filter(token => ['string', 'regexp', 'num'].includes(token.type.label)).map(token => token.loc.start.line));
        for (const { node } of lex.parsed.nodes) {
          if (node.type === 'SwitchStatement') {
            const opening = tokenAfter(lex.parsed, node.discriminant.end, '{');
            if (opening) switchOpenings.add(opening.start);
          }
          const bodies = node.type === 'IfStatement'
            ? [node.consequent, node.alternate && node.alternate.type !== 'IfStatement' ? node.alternate : null]
            : ['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'WithStatement'].includes(node.type) ? [node.body] : [];
          for (const body of bodies) {
            if (!body || body.type === 'BlockStatement' || body.loc.start.line <= node.loc.start.line) continue;
            unbraced[body.loc.start.line]++;
            unbraced[body.loc.end.line + 1]--;
          }
        }
        for (let line = 1; line < unbraced.length; line++) unbraced[line] += unbraced[line - 1];
        let depth = 0;
        const switchStack = [];
        let previousCode = '';
        let continuationDepth = 0;

        for (let index = 0; index < lex.structural.length; index++) {
          const structuralLine = lex.structural[index];
          const original = lex.lines[index];
          const trimmed = structuralLine.trim() || (literalLines.has(index + 1) ? 'literal' : '');
          if (!trimmed) continue;

          if (/^\s*\t+/.test(original) || /^ +\t/.test(original)) {
            addIssue(issues, {
              level: 'fix', line: index + 1,
              title: 'インデントにタブが使われています',
              suggestion: 'JavaScriptのインデントは半角スペース2個に統一してください。'
            });
          } else {
            const leading = countLeadingSpaces(original);
            const invalidIndentUnit = leading % 2 !== 0;
            if (invalidIndentUnit) {
              addIssue(issues, {
                level: 'fix', line: index + 1,
                title: 'インデントは半角スペース2個単位にしてください',
                message: `現在は先頭に ${leading} 個のスペースがあります。`
              });
            }

            const closesFirst = (trimmed.match(/^(?:}\s*)+/) || [''])[0].replace(/\s/g, '').length;
            const baseDepth = Math.max(0, depth - closesFirst);
            const isCase = /^(?:case\b.*:|default\s*:)/.test(trimmed);
            const caseExtra = switchStack.filter(entry => entry.activeCase && !entry.caseBlock && baseDepth >= entry.bodyDepth && !(isCase && baseDepth === entry.bodyDepth)).length;
            const expected = (baseDepth + caseExtra + unbraced[index + 1]) * 2;
            const continuation = continuationDepth > 0 || lineLooksLikeContinuation(structuralLine, previousCode);

            if (!invalidIndentUnit && !continuation && leading !== expected) {
              addIssue(issues, {
                level: 'warn', line: index + 1,
                title: `インデントを ${expected} スペースに揃えてください`,
                message: `現在は ${leading} スペースです。`,
                suggestion: 'ブロックごとに半角スペース2個でインデントしてください。'
              });
            } else if (!invalidIndentUnit && continuation && leading < expected) {
              addIssue(issues, {
                level: 'warn', line: index + 1,
                title: '継続行のインデントが浅すぎます',
                suggestion: `少なくとも ${expected} スペース以上を目安にしてください。`
              });
            }
          }

          const topSwitch = switchStack[switchStack.length - 1];
          if (topSwitch && depth === topSwitch.bodyDepth && /^(?:case\b.*:|default\s*:)/.test(trimmed)) {
            topSwitch.activeCase = true;
            topSwitch.caseBlock = /:\s*\{/.test(trimmed);
          }

          for (let col = 0; col < structuralLine.length; col++) {
            const ch = structuralLine[col];
            if (switchOpenings.has(offsets[index] + col)) switchStack.push({ bodyDepth: depth + 1, activeCase: false });
            if (ch === '(' || ch === '[') continuationDepth++;
            if (ch === ')' || ch === ']') continuationDepth = Math.max(0, continuationDepth - 1);
            if (ch === '{') depth++;
            if (ch === '}') {
              depth = Math.max(0, depth - 1);
              const last = switchStack[switchStack.length - 1];
              if (last && depth < last.bodyDepth) switchStack.pop();
            }
          }
          previousCode = structuralLine;
        }
      }

      function analyzeJsSemicolons(lex, issues) {
        const expressionEnds = new Set(lex.parsed.nodes.filter(({ node }) => {
          if (node.type !== 'VariableDeclaration') return false;
          const initializer = node.declarations[node.declarations.length - 1].init;
          return initializer && ['FunctionExpression', 'ArrowFunctionExpression', 'ObjectExpression'].includes(initializer.type)
            && lex.source[node.end - 1] === '}';
        }).map(({ node }) => node.end));
        for (const { offset, loc } of lex.parsed.semicolons) {
          addIssue(issues, {
            level: 'fix', line: loc.line,
            title: expressionEnds.has(offset)
              ? '関数式・アロー関数・オブジェクト代入の末尾にセミコロンを付けてください'
              : '文末にセミコロンを付けてください',
            suggestion: expressionEnds.has(offset) ? '代入式の終端は }; とします。' : 'この現場ではセミコロンを原則付与します。'
          });
        }
        const tokensByStart = new Map(lex.parsed.tokens.map(token => [token.start, token]));
        const nextToken = new Map(lex.parsed.tokens.map((token, index) => [token.start, lex.parsed.tokens[index + 1]]));
        for (const { node } of lex.parsed.nodes) {
          if (node.type !== 'FunctionDeclaration') continue;
          const closing = tokensByStart.get(node.end - 1);
          const after = closing && nextToken.get(closing.start);
          if (after && after.type.label === ';') {
            addIssue(issues, {
              level: 'fix', line: after.loc.start.line,
              title: '関数宣言の末尾にはセミコロンを付けません',
              suggestion: '閉じ波括弧の後ろの ; を削除してください。'
            });
          }
        }
      }

      function analyzeJavaScript(lex, issues) {
        analyzeJsQuotes(lex, issues);
        analyzeJsEquality(lex, issues);
        analyzeJsValueComparison(lex, issues);
        analyzeJsSpacing(lex, issues);
        analyzeJsIndentation(lex, issues);
        analyzeJsSemicolons(lex, issues);
        for (const { node } of lex.parsed.nodes) {
          const line = node.loc.start.line;
          if (node.type === 'VariableDeclaration' && node.kind === 'var') {
            addIssue(issues, {
              level: 'fix', line,
              title: 'var は禁止です',
              suggestion: '再代入しない場合は const、再代入が必要な場合は let を使用してください。'
            });
          }
          if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
            const callee = node.callee;
            const property = staticMemberName(callee);
            if (callee.object.type === 'Identifier' && callee.object.name === 'console' && property === 'log' && (lex.jsModel || (lex.jsModel = createJavaScriptModel(lex.parsed))).isGlobalMember('console', 'log', node)) {
              addIssue(issues, {
                level: 'warn', line,
                title: 'console.log が残っています',
                suggestion: 'デバッグ出力の消し忘れでないか確認してください。'
              });
            }
          }
          if (node.type === 'DebuggerStatement') {
            addIssue(issues, {
              level: 'fix', line,
              title: 'debugger が残っています',
              suggestion: 'コミット前に削除してください。'
            });
          }
          if (node.type === 'CatchClause' && node.body.body.length === 0 && lex.source[node.body.end - 1] === '}') {
            addIssue(issues, {
              level: 'warn', line,
              title: '空の catch ブロックがあります',
              suggestion: '例外を意図的に無視する場合でも、理由が分かる実装にしてください。'
            });
          }
        }
      }

      function dedupeIssues(issues) {
        const seen = new Set();
        return issues.filter(issue => {
          const key = [issue.line, issue.endLine, issue.title].join('|');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      function reviewSource(source, lang) {
        const lex = lexSource(source, lang);
        const issues = [];
        analyzeComments(lex, lang, issues);
        analyzeCommon(lex, lang, issues);
        if (lang === 'java') analyzeJava(lex, issues);
        else analyzeJavaScript(lex, issues);

        const rank = { fix: 0, warn: 1, info: 2 };
        const sorted = dedupeIssues(issues).sort((a, b) => a.line - b.line || rank[a.level] - rank[b.level] || a.title.localeCompare(b.title, 'ja'));
        return { issues: sorted, lex };
      }

      function invalidateReview() {
        revision++;
        clearTimeout(reviewTimer);
        reviewTimer = null;
        if (renderFrame != null) cancelAnimationFrame(renderFrame);
        renderFrame = null;
        if (workerBusy) disposeWorker();
        if (lastIssues.length) {
          gutterState.levels.fill(0);
          gutterState.first = -1;
          syncGutterScroll();
        }
        lastIssues = [];
        lastLex = null;
        renderedSource = '';
        els.resultList.setAttribute('aria-busy', 'false');
        els.resultList.dataset.analysisState = 'pending';
        els.resultList.innerHTML = '';
        els.summary.innerHTML = '';
      }

      function disposeWorker() {
        if (worker) worker.terminate();
        worker = null;
        workerBusy = false;
        if (workerURL) URL.revokeObjectURL(workerURL);
        workerURL = null;
      }

      function ensureWorker() {
        if (worker) return worker;
        if (workerUnavailable || typeof Worker === 'undefined' || !appSource) return null;
        try {
          workerURL = URL.createObjectURL(new Blob([
            document.getElementById('review-parser').textContent, '\n', appSource
          ], { type: 'text/javascript' }));
          worker = new Worker(workerURL);
          return worker;
        } catch (_) {
          disposeWorker();
          workerUnavailable = true;
          return null;
        }
      }

      function prepareReview(source, lang) {
        const result = reviewSource(source, lang);
        // ASTs and parser token classes stay in the worker and are never cloned to the UI.
        return {
          issues: result.issues,
          lex: { lines: result.lex.lines, complete: result.lex.complete !== false },
          cards: resultCards(result.issues, result.lex.lines)
        };
      }

      function runReview() {
        invalidateReview();
        if (isComposing) return;
        const id = revision;
        const source = els.code.value;
        const lang = language;
        const apply = result => {
          if (id !== revision || source !== els.code.value || lang !== language) return;
          workerBusy = false;
          lastIssues = result.issues;
          lastLex = result.lex;
          renderedSource = source;
          renderedLanguage = lang;
          els.resultList.dataset.analysisState = result.lex.complete ? 'complete' : 'partial';
          renderResults(lastIssues, result.cards);
          updateGutter(lastIssues);
        };
        if (!source.trim()) {
          disposeWorker();
          apply({ issues: [], lex: { lines: source.split('\n'), complete: true }, cards: [] });
          return;
        }
        const fallback = () => {
          try { apply(prepareReview(source, lang)); }
          catch (_) {
            apply({ issues: [], lex: { lines: source.split('\n'), complete: false }, cards: [] });
          }
        };
        els.resultList.setAttribute('aria-busy', 'true');
        const current = ensureWorker();
        if (!current) { fallback(); return; }
        workerBusy = true;
        current.onmessage = event => {
          if (current !== worker || event.data.id !== id || id !== revision) return;
          if (event.data.failed) {
            disposeWorker();
            apply({ issues: [], lex: { lines: source.split('\n'), complete: false }, cards: [] });
          } else apply(event.data.result);
        };
        const workerFailed = event => {
          if (event?.preventDefault) event.preventDefault();
          if (current !== worker || id !== revision) return;
          disposeWorker();
          workerUnavailable = true;
          fallback();
        };
        current.onerror = workerFailed;
        current.onmessageerror = workerFailed;
        try { current.postMessage({ id, source, language: lang }); }
        catch (_) { workerFailed(); }
      }

      function categoryForIssue(issue) {
        const text = `${issue.title || ''} ${issue.message || ''}`;
        if (/(?:変数名|メソッド名|クラス名|定数|Boolean|略語|接頭辞|UPPER_SNAKE_CASE|lowerCamelCase|PascalCase)/.test(text)) return '命名';
        if (/(?:インデント|スペース|セミコロン|シングルクォート|ダブルクォート|文字列|1行が\d+文字|文末|波括弧)/.test(text)) return '書式';
        return 'コード品質';
      }

      function fixExampleForIssue(issue, snippet, getParsed = () => parseJavaScript(snippet)) {
        if (!snippet) return issue.suggestion || '';
        const title = issue.title || '';
        if (!/var は禁止|シングルクォート|ダブルクォート|===|!==|キーワード.*スペース|半角スペース1個|波括弧|\{.*スペース|文末にセミコロン|関数宣言の末尾にはセミコロン/.test(title)) return issue.suggestion || '';
        const parsed = getParsed();
        // Truncated cards and recovered syntax are unsuitable for executable examples.
        if (!parsed.complete) return issue.suggestion || '';
        const replaceToken = (token, value) => token
          ? snippet.slice(0, token.start) + value + snippet.slice(token.end)
          : issue.suggestion || '';

        if (title === 'var は禁止です') {
          const declaration = parsed.nodes.find(({ node }) => node.type === 'VariableDeclaration' && node.kind === 'var');
          // A const example would break a variable that is reassigned elsewhere.
          return replaceToken(declaration && { start: declaration.node.start, end: declaration.node.start + 3 }, 'let');
        }
        if (title === '文字列はシングルクォートを使用してください') {
          const token = parsed.tokens.find(token => token.type.label === 'string' && snippet[token.start] === '"');
          if (token) {
            // Keep escapes verbatim: decoding an escaped directive can enable strict mode.
            const content = snippet.slice(token.start + 1, token.end - 1)
              .replace(/\\.|'/g, part => part === '\\"' ? '"' : part === "'" ? "\\'" : part);
            return replaceToken(token, "'" + content + "'");
          }
        } else if (/===|!==/.test(title)) {
          const operator = title.startsWith('!=') ? '!=' : '==';
          const entry = parsed.nodes.find(({ node }) => node.type === 'BinaryExpression' && node.operator === operator
            && ![node.left, node.right].some(value => value.type === 'Literal' && value.value === null));
          if (entry) {
            const token = comparisonToken(parsed, entry.node);
            return replaceToken(token, operator + '=');
          }
        } else if (/^(?:if|for|while|switch|catch) の後ろ/.test(title)) {
          const keyword = title.split(' ')[0];
          const starts = controlKeywordStarts(parsed);
          const tokenIndex = parsed.tokens.findIndex((token, index) => starts.has(token.start) && token.type.label === keyword && parsed.tokens[index + 1]?.type.label === '(' && snippet.slice(token.end, parsed.tokens[index + 1].start) !== ' ' && !/\/\*|\/\//.test(snippet.slice(token.end, parsed.tokens[index + 1].start)));
          const token = parsed.tokens[tokenIndex];
          const next = parsed.tokens[tokenIndex + 1];
          if (token && next && next.type.label === '(' && !/\/\*|\/\//.test(snippet.slice(token.end, next.start))) return replaceToken({ start: token.end, end: next.start }, ' ');
        } else if (/波括弧|\{.*スペース/.test(title)) {
          const openings = new Set(parsed.nodes.flatMap(({ node }) => node.type === 'SwitchStatement'
            ? [tokenAfter(parsed, node.discriminant.end, '{')?.start]
            : ['BlockStatement', 'ClassBody'].includes(node.type) ? [node.start] : []));
          const token = parsed.tokens.find(token => openings.has(token.start) && token.type.label === '{' && !/\S $/.test(snippet.slice(0, token.start)));
          if (token) {
            const start = snippet.slice(0, token.start).trimEnd().length;
            return replaceToken({ start, end: token.start }, ' ');
          }
        } else if (/文末にセミコロン/.test(title) && parsed.semicolons.length) {
          const offset = parsed.semicolons[0].offset;
          return replaceToken({ start: offset, end: offset }, ';');
        } else if (/関数宣言の末尾にはセミコロン/.test(title)) {
          for (const { node } of parsed.nodes) {
            if (node.type !== 'FunctionDeclaration') continue;
            const after = tokenAfter(parsed, node.end);
            if (after?.type.label === ';') return replaceToken(after, '');
          }
        }
        return issue.suggestion || '';
      }

      function groupIssuesByLine(issues) {
        const groups = new Map();
        for (const issue of issues) {
          const key = issue.line;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(issue);
        }
        return [...groups.entries()].map(([line, items]) => ({ line, items }));
      }

      function renderResults(issues, preparedCards) {
        els.resultList.setAttribute('aria-busy', 'false');
        const counts = issues.reduce((acc, issue) => {
          acc[issue.level]++;
          return acc;
        }, { fix: 0, warn: 0, info: 0 });

        els.summary.innerHTML = issues.length
          ? `<span class="count-pill gm-badge fix">要修正 ${counts.fix}</span><span class="count-pill gm-badge warn">警告 ${counts.warn}</span><span class="count-pill gm-badge info">情報 ${counts.info}</span>`
          : '';

        if (!els.code.value.trim()) {
          els.resultList.innerHTML = '';
          return;
        }

        if (issues.length === 0 && lastLex && !lastLex.complete) {
          els.resultList.innerHTML = '';
          return;
        }

        if (issues.length === 0) {
          els.resultList.innerHTML = `
            <div class="empty-state gm-empty">
              <div>
                <div class="empty-icon"><svg xmlns="http://www.w3.org/2000/svg" class="gm-icon" data-icon="check" viewBox="0 -960 960 960" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false"><path d="M389-267 195-460l51-52 143 143 325-324 51 51-376 375Z"/></svg></div>
                <div class="empty-title">現在のルールでは指摘はありません</div>
              </div>
            </div>`;
          return;
        }

        const cards = preparedCards || resultCards(issues, lastLex ? lastLex.lines : els.code.value.split('\n'));
        els.resultList.innerHTML = '';
        const id = revision;
        let index = 0;
        const append = () => {
          if (id !== revision) return;
          els.resultList.insertAdjacentHTML('beforeend', cards.slice(index, index + 40).join(''));
          index += 40;
          if (index < cards.length) renderFrame = requestAnimationFrame(append);
          else { renderFrame = null; els.resultList.setAttribute('aria-busy', 'false'); }
        };
        if (cards.length <= 80 || typeof requestAnimationFrame === 'undefined') {
          els.resultList.innerHTML = cards.join('');
          els.resultList.setAttribute('aria-busy', 'false');
        } else { els.resultList.setAttribute('aria-busy', 'true'); append(); }
      }

      function resultCards(issues, lines) {
        const groups = groupIssuesByLine(issues);

        return groups.map(group => {
          const snippet = lineSnippet(lines, group.line);
          const visible = group.items.slice(0, MAX_ISSUES_PER_LINE);
          const hiddenCount = Math.max(0, group.items.length - visible.length);
          const highest = visible.some(i => i.level === 'fix') ? 'fix' : visible.some(i => i.level === 'warn') ? 'warn' : 'info';

          let parsedSnippet;
          // A truncated line can still parse (for example inside a // comment).
          // Never present that shortened source as a complete replacement.
          const getParsed = () => parsedSnippet ||= (lines[group.line - 1] || '').trim().length > snippet.length
            ? { complete: false } : parseJavaScript(snippet);
          const issueHtml = visible.map(issue => {
            const example = fixExampleForIssue(issue, snippet, getParsed);
            return `
              <div class="line-issue">
                <div class="issue-meta">
                  <span class="level-chip gm-badge ${issue.level}">${levelLabel(issue.level)}</span>
                  <span class="category-chip gm-badge">${categoryForIssue(issue)}</span>
                </div>
                <div class="issue-title">${escapeHtml(issue.title)}</div>
                ${issue.message ? `<div class="issue-message">${escapeHtml(issue.message)}</div>` : ''}
                ${example ? `<div class="fix-example"><strong>修正例</strong>${escapeHtml(example)}</div>` : ''}
              </div>`;
          }).join('');

          return `
            <button type="button" class="line-card gm-btn" data-line="${group.line}" aria-label="Line ${group.line} の指摘 ${group.items.length}件" aria-describedby="line-issues-${group.line}" aria-controls="codeInput">
              <div class="line-card-head">
                <span class="line-label">L${group.line}</span>
                <span class="level-chip gm-badge ${highest}">${group.items.length}件</span>
              </div>
              ${snippet ? `<pre class="line-code">${escapeHtml(snippet)}</pre>` : ''}
              <div class="line-issues" id="line-issues-${group.line}">${issueHtml}</div>
              ${hiddenCount ? `<div class="more-issues">ほか ${hiddenCount} 件の指摘を省略しています</div>` : ''}
            </button>`;
        });
      }

      function updateGutter(issues = lastIssues) {
        const count = Math.max(1, els.code.value.split('\n').length);
        // Most edits have no current findings. Skip range arrays and per-line
        // severity accumulation while the replacement review is pending.
        if (!issues?.length) {
          gutterState = { count, levels: new Uint8Array(0), first: -1, last: -1 };
          syncGutterScroll();
          return;
        }
        const ranges = [new Int32Array(count + 2), new Int32Array(count + 2), new Int32Array(count + 2)];
        const rank = { info: 0, warn: 1, fix: 2 };
        for (const issue of issues || []) {
          const start = Math.max(1, issue.line);
          const end = Math.min(count, issue.endLine);
          if (start > end) continue;
          ranges[rank[issue.level]][start]++;
          ranges[rank[issue.level]][end + 1]--;
        }
        const levels = new Uint8Array(count + 1);
        const active = [0, 0, 0];
        for (let line = 1; line <= count; line++) {
          for (let level = 0; level < 3; level++) {
            active[level] += ranges[level][line];
            if (active[level]) levels[line] = level + 1;
          }
        }
        gutterState = { count, levels, first: -1, last: -1 };
        syncGutterScroll();
      }

      function syncGutterScroll() {
        const height = parseFloat(getComputedStyle(els.code).lineHeight) || 22;
        const count = gutterState.count;
        const visible = Math.ceil((els.code.clientHeight || 600) / height);
        const first = count <= 200 ? 1 : Math.min(count, Math.max(1, Math.floor(els.code.scrollTop / height) - 40));
        const last = count <= 200 ? count : Math.min(count, first + visible + 80);
        if (first !== gutterState.first || last !== gutterState.last) {
          let html = '';
          for (let line = first; line <= last; line++) {
            const level = ['', 'info', 'warn', 'fix'][gutterState.levels[line]];
            const cls = level ? `gutter-line has-issue has-${level}` : 'gutter-line';
            html += `<div class="${cls}">${line}</div>`;
          }
          els.gutter.innerHTML = html;
          gutterState.first = first;
          gutterState.last = last;
        }
        // Position the visible rows without expanding the grid's intrinsic height.
        // Large padding here feeds textarea layout back into its own scroll events.
        els.gutter.style.transform = `translateY(${(first - 1) * height - els.code.scrollTop}px)`;
      }

      function jumpToLine(lineNumber) {
        const source = els.code.value;
        const lines = source.split('\n');
        if (!Number.isFinite(lineNumber)) return;
        const clamped = Math.min(Math.max(1, Math.trunc(lineNumber)), lines.length);
        let start = 0;
        for (let i = 0; i < clamped - 1; i++) start += lines[i].length + 1;
        const end = start + lines[clamped - 1].length;
        els.code.focus();
        els.code.setSelectionRange(start, end);
        const lineHeight = parseFloat(getComputedStyle(els.code).lineHeight) || 22;
        els.code.scrollTop = Math.max(0, (clamped - 4) * lineHeight);
        syncGutterScroll();
      }

      function switchLanguage(next) {
        if (!['java', 'javascript'].includes(next) || next === language) return;
        language = next;
        els.langBtns.forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.language === language)));
        if (language === 'javascript') {
          els.code.setAttribute('placeholder', 'JavaScriptコードを貼り付けてください。');
        } else {
          els.code.setAttribute('placeholder', 'Javaコードを貼り付けてください。');
        }
        runReview();
      }

      els.code.addEventListener('input', () => {
        updateGutter([]);
        scheduleReview();
      });

      els.code.addEventListener('compositionstart', () => { isComposing = true; invalidateReview(); });
      els.code.addEventListener('compositionend', () => { isComposing = false; scheduleReview(); });
      els.resultList.addEventListener('click', event => {
        const card = event.target.closest('.line-card');
        if (!card || !els.resultList.contains(card)) return;
        if (renderedSource !== els.code.value || renderedLanguage !== language) { runReview(); return; }
        jumpToLine(Number(card.dataset.line));
      });
      if (window.addEventListener) {
        window.addEventListener('storage', event => {
          if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
          try { if (event.storageArea && event.storageArea !== localStorage) return; }
          catch (_) { return; }
          themePreference = event.newValue === 'dark' || event.newValue === 'light' ? event.newValue : null;
          setTheme(themePreference || (systemTheme?.matches ? 'dark' : 'light'), false);
        });
        window.addEventListener('resize', () => { gutterState.first = -1; syncGutterScroll(); });
        window.addEventListener('pagehide', () => { isComposing = false; invalidateReview(); disposeWorker(); });
        window.addEventListener('pageshow', event => {
          // Browsers can restore textarea values after our script has run,
          // including ordinary history navigation without the back-forward cache.
          if (event.persisted || els.code.value !== renderedSource) runReview();
        });
      }

      els.code.addEventListener('scroll', syncGutterScroll, { passive: true });

      function insertEditorText(text, start, end) {
        els.code.setSelectionRange(start, end);
        let inserted = false;
        try { inserted = Boolean(document.execCommand && document.execCommand('insertText', false, text)); }
        catch (_) { /* A restricted document can still use the textarea editing API. */ }
        if (!inserted) {
          els.code.setRangeText(text, start, end, 'end');
          els.code.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      els.code.addEventListener('keydown', event => {
        if (event.key === 'Tab' && language === 'javascript' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && !isComposing) {
          event.preventDefault();
          const start = els.code.selectionStart;
          const end = els.code.selectionEnd;
          if (start === end) {
            insertEditorText('  ', start, end);
          } else {
            const source = els.code.value;
            const direction = els.code.selectionDirection;
            const lineStart = start === 0 ? 0 : source.lastIndexOf('\n', start - 1) + 1;
            const affectedEnd = source[end - 1] === '\n' ? end - 1 : end;
            const selected = source.slice(lineStart, affectedEnd);
            const lineCount = selected.split('\n').length;
            // Textarea rows use LF. RegExp multiline anchors also match Unicode
            // separators, which may be characters inside a string literal.
            insertEditorText(selected.split('\n').map(line => '  ' + line).join('\n'), lineStart, affectedEnd);
            els.code.setSelectionRange(start + 2, end + lineCount * 2, direction);
          }
        }
      });

      els.langBtns.forEach(btn => btn.addEventListener('click', () => switchLanguage(btn.dataset.language)));

      els.clearBtn.addEventListener('click', () => {
        isComposing = false;
        els.code.focus();
        if (els.code.value) {
          const source = els.code.value;
          // WebKit can merge even a button-triggered deletion into the preceding
          // typing command. Round-trip the last native edit to close that group
          // before clearing; both operations finish before the browser paints.
          try {
            // Replaying a huge edit can block native textarea layout. Large
            // buffers keep the browser's normal undo grouping and clear directly.
            if (source.length <= 100000 && document.queryCommandEnabled?.('undo') && document.execCommand('undo')) document.execCommand('redo');
          } catch (_) { /* Legacy editing APIs may be restricted. */ }
          // Form restoration or a blocked redo can leave the native history out
          // of sync. Always preserve the actual editor value before deleting it.
          if (els.code.value !== source) els.code.value = source;
          insertEditorText('', 0, source.length);
        }
        lastIssues = [];
        runReview();
      });

      els.themeToggle.addEventListener('click', () => {
        const nextTheme = getTheme() === 'dark' ? 'light' : 'dark';
        setTheme(nextTheme);
      });

      // Initial state
      renderThemeToggle();
      updateGutter([]);
      runReview();
    })();
